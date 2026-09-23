#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * genera-remote — drive Genera from the host, as an MCP server or a CLI.
 *
 * Two of Genera's own network services, no telnet:
 *
 *   rsh, TCP 514          evaluate one form, or run one CP command, and get
 *                         its output back whole (genera-rsh.ts).  No login
 *                         needed; nothing is lost to a 24-row screen.
 *   3600-LOGIN, TCP 57    Genera's native remote terminal (genera-3600.ts):
 *                         full Genera characters in (Function, Select, any
 *                         bucky bits), a small op set out, live resize.
 *
 * Layers, bottom up:
 *
 *   1. Codecs          — genera-rsh.ts and genera-3600.ts (no I/O policy).
 *   2. GeneraSession   — a 3600 login held open, its Screen grid, and the
 *                        wait/prompt logic; eval and command go over rsh.
 *   3. MCP / CLI       — tools and subcommands on top of the session, plus
 *                        `repl`, an interactive full-screen 3600 terminal.
 *
 * The first version of this tool spoke telnet and screen-scraped the
 * Listener; that layer is gone.  Only the MCP layer reaches for npm.  See
 * README.md for the protocol notes and what Genera must have enabled.
 */

import {
  DEFAULT_RSH_PORT,
  evalForm as rshEvalForm,
  type EvalResult,
  runCommand as rshRunCommand,
} from "./genera-rsh.ts";
import {
  ansiSink,
  Decoder3600,
  encodeChar,
  encodeSize,
  encodeText,
  KEY_CODES,
  keyNames,
  LOGOUT,
  parseKey,
  Screen,
} from "./genera-3600.ts";

export { keyNames, parseKey, Screen };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_HOST = "192.168.2.2";
export const DEFAULT_LOGIN_PORT = 57;
export { DEFAULT_RSH_PORT };

/** How long to wait for a TCP connection to the login server. */
const CONNECT_TIMEOUT_MS = 5000;

/** Said whenever the 3600-LOGIN server cannot be reached. */
export const LOGIN_REQUIREMENTS =
  "Genera's 3600-LOGIN server answers only while remote login is on and " +
  "this host is trusted (Secure Subnets).";

const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

// ---------------------------------------------------------------------------
// Eval errors: show the user their form, not our wrapper
// ---------------------------------------------------------------------------

/** The quoted wrapper, as Genera prints it back in a read error. */
const WRAPPER_ECHO_RE =
  /\(CONDITIONS:HANDLER-CASE[\s\S]*?RSH[0-9a-f]{16}E~A~%" E\)\)\)\)/i;
const NONCE_RE = /RSH[0-9a-f]{16}/g;

/**
 * Tidy an error from `evalForm` for display.  A read error quotes the whole
 * wrapper (nonce included): put the caller's form back in its place.  More
 * than one form lands in MULTIPLE-VALUE-LIST's argument list: say so plainly.
 */
export function tidyEvalError(error: string, form: string): string {
  if (/Incorrect arguments to MULTIPLE-VALUE-LIST/i.test(error)) {
    return "eval takes a single form; wrap several in (progn ...).\n" +
      `Genera said: ${error.replace(NONCE_RE, "…")}`;
  }
  return error.replace(WRAPPER_ECHO_RE, form.trim()).replace(NONCE_RE, "…");
}

/**
 * Check a form's parentheses before sending it.  An extra `)` would close
 * the wrapper early and Genera would report nonsense about the wrapper, so
 * that one is caught here.  Knows strings, `|symbols|`, `\` escapes (so
 * `#\(` is fine), `;` and `#| |#` comments.  Returns an error or null.
 */
export function checkForm(form: string): string | null {
  let depth = 0;
  let sawAny = false;
  for (let i = 0; i < form.length; i++) {
    const c = form[i];
    if (c === "\\") {
      i++;
      sawAny = true;
    } else if (c === ";") {
      while (i < form.length && form[i] !== "\n") i++;
    } else if (c === "#" && form[i + 1] === "|") {
      const end = form.indexOf("|#", i + 2);
      if (end < 0) return "unterminated #| comment";
      i = end + 1;
    } else if (c === '"' || c === "|") {
      let j = i + 1;
      while (j < form.length && form[j] !== c) j += form[j] === "\\" ? 2 : 1;
      if (j >= form.length) return `unterminated ${c}`;
      i = j;
      sawAny = true;
    } else if (c === "(") {
      depth++;
      sawAny = true;
    } else if (c === ")") {
      if (--depth < 0) return "unbalanced parentheses: an extra ')'";
    } else if (!/\s/.test(c)) sawAny = true;
  }
  if (!sawAny) return "empty form";
  if (depth > 0) return `unbalanced parentheses: ${depth} unclosed '('`;
  return null;
}

// ---------------------------------------------------------------------------
// Session — a 3600-LOGIN connection + screen; eval/command over rsh
// ---------------------------------------------------------------------------

export interface ActionLogEntry {
  time: string;
  intent: string;
  outcome: string;
}

export interface SessionOptions {
  host?: string;
  loginPort?: number;
  rshPort?: number;
  cols?: number;
  rows?: number;
  promptPattern?: RegExp;
  logLimit?: number;
}

/**
 * Genera's command loop paints a prompt and leaves the cursor just past it.
 * We detect "at a prompt" by matching the cursor row's text *up to the
 * cursor*, so an echoed form on the same line prevents a false positive.
 */
export const DEFAULT_PROMPT_PATTERN =
  /(?:^|\s)(?:Command:|Eval:|Lisp>|[A-Za-z0-9 .*+-]*(?:>|»))\s*$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const octBytes = (b: number[]) =>
  b.map((x) => x.toString(8).padStart(3, "0")).join(" ");

export interface SessionEvalResult extends EvalResult {
  elapsedMs: number;
}

export interface SessionCommandResult {
  output: string;
  error?: string;
  timedOut?: boolean;
  elapsedMs: number;
}

export class GeneraSession {
  screen: Screen;
  host: string;
  loginPort: number;
  rshPort: number;
  promptPattern: RegExp;
  readonly actionLog: ActionLogEntry[] = [];
  /** Called when the login connection comes up or goes away, for any reason. */
  onConnectionChange?: (connected: boolean) => void;
  #conn: Deno.TcpConn | null = null;
  #sending: Promise<void> = Promise.resolve();
  #logLimit: number;
  #lastChangeAt = 0;
  #connectedAt: string | null = null;
  #closeReason: string | null = null;

  constructor(opts: SessionOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.loginPort = opts.loginPort ?? DEFAULT_LOGIN_PORT;
    this.rshPort = opts.rshPort ?? DEFAULT_RSH_PORT;
    this.promptPattern = opts.promptPattern ?? DEFAULT_PROMPT_PATTERN;
    this.#logLimit = opts.logLimit ?? 500;
    this.screen = new Screen({ cols: opts.cols ?? 80, rows: opts.rows ?? 24 });
    this.#lastChangeAt = Date.now();
  }

  get connected(): boolean {
    return this.#conn !== null;
  }

  note(intent: string, outcome: string): ActionLogEntry {
    const entry = { time: new Date().toISOString(), intent, outcome };
    this.actionLog.push(entry);
    if (this.actionLog.length > this.#logLimit) this.actionLog.shift();
    return entry;
  }

  /**
   * Open the 3600-LOGIN connection and send the screen size at once (the
   * server gives the client about two seconds to do so).
   */
  async connect(
    host?: string,
    port?: number,
    size?: { cols?: number; rows?: number },
  ): Promise<ActionLogEntry> {
    if (this.connected) {
      return this.note(
        "connect",
        `already connected to ${this.host}:${this.loginPort}`,
      );
    }
    this.host = host ?? this.host;
    this.loginPort = port ?? this.loginPort;
    const cols = size?.cols ?? this.screen.cols;
    const rows = size?.rows ?? this.screen.rows;
    this.screen.resize(cols, rows);
    this.screen.reset();
    this.#closeReason = null;
    const where = `connect ${this.host}:${this.loginPort}`;
    let conn: Deno.TcpConn;
    try {
      conn = await Deno.connect({
        hostname: this.host,
        port: this.loginPort,
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (e) {
      const why = e instanceof Deno.errors.ConnectionRefused
        ? `connection refused. ${LOGIN_REQUIREMENTS}`
        : e instanceof DOMException && e.name === "TimeoutError"
        ? `no answer in ${CONNECT_TIMEOUT_MS}ms`
        : errText(e);
      return this.note(where, `FAILED: ${why}`);
    }
    this.#conn = conn;
    this.#sending = Promise.resolve();
    this.#connectedAt = new Date().toISOString();
    this.#lastChangeAt = Date.now();
    this.#readLoop(conn);
    try {
      await this.#send(encodeSize(cols, rows));
    } catch (e) {
      this.#drop(`write failed: ${errText(e)}`);
      return this.note(where, `FAILED: ${errText(e)}`);
    }
    this.onConnectionChange?.(true);
    return this.note(where, `connected, size ${cols}x${rows} sent`);
  }

  async #readLoop(conn: Deno.TcpConn): Promise<void> {
    const buf = new Uint8Array(8192);
    let reason = "peer closed the connection";
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        this.screen.writeBytes(buf.subarray(0, n));
        this.#lastChangeAt = Date.now();
      }
    } catch (e) {
      reason = `read failed: ${errText(e)}`;
    }
    if (this.#conn === conn) this.#drop(reason);
  }

  #drop(reason: string): void {
    const conn = this.#conn;
    this.#conn = null;
    this.#connectedAt = null;
    this.#closeReason = reason;
    this.#lastChangeAt = Date.now();
    try {
      conn?.close();
    } catch { /* already closed */ }
    if (conn) this.onConnectionChange?.(false);
  }

  /** Queue bytes on the login connection, in order. */
  #send(bytes: readonly number[]): Promise<void> {
    const conn = this.#conn;
    if (!conn) return Promise.reject(new Error("not connected"));
    const data = Uint8Array.from(bytes);
    const p = this.#sending.then(async () => {
      let off = 0;
      while (off < data.length) off += await conn.write(data.subarray(off));
    });
    this.#sending = p.catch(() => {});
    return p;
  }

  /** Send logout, then close. */
  async disconnect(): Promise<ActionLogEntry> {
    if (!this.#conn) return this.note("disconnect", "was not connected");
    let outcome = "logged out";
    try {
      await this.#send(LOGOUT);
    } catch (e) {
      outcome = `logout not sent (${errText(e)}); closed`;
    }
    this.#drop("disconnected by us");
    return this.note("disconnect", outcome);
  }

  /** State summary for genera_state. */
  state(): Record<string, unknown> {
    return {
      connected: this.connected,
      host: this.host,
      loginPort: this.loginPort,
      rshPort: this.rshPort,
      connectedAt: this.#connectedAt,
      closeReason: this.#closeReason,
      cols: this.screen.cols,
      rows: this.screen.rows,
      cursor: { row: this.screen.cursorRow, col: this.screen.cursorCol },
      atPrompt: this.atPrompt(),
      beeps: this.screen.beeps,
      unknownOpBytes: this.screen.unknownBytes.length,
    };
  }

  #requireConnection(): void {
    if (!this.connected) {
      throw new Error(
        `not connected (login ${this.host}:${this.loginPort}) — call genera_connect first`,
      );
    }
  }

  /** Type text: printable ASCII, newline = Return, tab = Tab, SAIL glyphs. */
  async type(text: string): Promise<ActionLogEntry> {
    this.#requireConnection();
    const bytes = encodeText(text);
    await this.#send(bytes);
    return this.note(
      `type ${JSON.stringify(text)}`,
      `sent ${bytes.length / 3} chars`,
    );
  }

  /** Press one key, e.g. `Return`, `c-m-Abort`, `m-X`, `Select`. */
  async key(spec: string): Promise<ActionLogEntry> {
    this.#requireConnection();
    const bytes = parseKey(spec);
    await this.#send(bytes);
    return this.note(`key ${spec}`, `sent ${octBytes(bytes)} (octal)`);
  }

  /** Text of the cursor row up to the cursor — where a prompt would sit. */
  promptLine(): string {
    const row = this.screen.grid[this.screen.cursorRow] ?? [];
    return row.join("").slice(0, this.screen.cursorCol);
  }

  atPrompt(): boolean {
    return this.promptPattern.test(this.promptLine());
  }

  async wait(opts: {
    pattern?: string;
    stableMs?: number;
    timeoutMs?: number;
  }): Promise<
    { matched: boolean; stable: boolean; timedOut: boolean; elapsedMs: number }
  > {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    // With neither condition given, "settled" is the useful default.
    const stableMs = opts.stableMs ??
      (opts.pattern === undefined ? 400 : undefined);
    const re = opts.pattern !== undefined ? new RegExp(opts.pattern) : null;
    const start = Date.now();

    while (true) {
      if (re && re.test(this.screen.text())) {
        return {
          matched: true,
          stable: false,
          timedOut: false,
          elapsedMs: Date.now() - start,
        };
      }
      // "Stable" means stableMs with no change *since this call began*, so an
      // in-flight round trip (which bumps #lastChangeAt) always gets a chance
      // to land before we declare the screen settled.
      const quietSince = Math.max(this.#lastChangeAt, start);
      if (stableMs !== undefined && Date.now() - quietSince >= stableMs) {
        return {
          matched: false,
          stable: true,
          timedOut: false,
          elapsedMs: Date.now() - start,
        };
      }
      if (Date.now() - start >= timeoutMs) {
        return {
          matched: false,
          stable: false,
          timedOut: true,
          elapsedMs: Date.now() - start,
        };
      }
      await sleep(15);
    }
  }

  /**
   * After connect: Genera paints the herald only once its init window has
   * passed (over a second), so wait for a prompt, then for quiet.
   */
  async awaitHerald(timeoutMs = 6000): Promise<{ atPrompt: boolean }> {
    const start = Date.now();
    while (
      this.connected && !this.atPrompt() && Date.now() - start < timeoutMs
    ) {
      await sleep(15);
    }
    const left = timeoutMs - (Date.now() - start);
    await this.wait({ stableMs: 300, timeoutMs: Math.max(left, 1000) });
    return { atPrompt: this.atPrompt() };
  }

  /**
   * Evaluate one form over rsh (read in CL-USER).  Needs no login.  Returns
   * what it printed and its values, or the error.  On timeout only the
   * socket is closed: the form keeps running in Genera.
   */
  async evalForm(form: string, timeoutMs = 30_000): Promise<SessionEvalResult> {
    const start = Date.now();
    const intent = `eval ${JSON.stringify(form)}`;
    const bad = checkForm(form);
    if (bad) {
      this.note(intent, `not sent: ${bad}`);
      return { output: "", error: bad, elapsedMs: 0 };
    }
    let r: EvalResult;
    try {
      r = await rshEvalForm(this.host, this.rshPort, form, { timeoutMs });
    } catch (e) {
      r = {
        output: "",
        error: `rsh ${this.host}:${this.rshPort}: ${errText(e)}`,
      };
    }
    if (r.error !== undefined) {
      r = { ...r, error: tidyEvalError(r.error, form) };
    }
    const elapsedMs = Date.now() - start;
    this.note(
      intent,
      r.timedOut
        ? `TIMED OUT after ${elapsedMs}ms`
        : r.error !== undefined
        ? `error: ${r.error.split("\n")[0]}`
        : `${r.values?.length ?? 0} value(s) in ${elapsedMs}ms`,
    );
    return { ...r, elapsedMs };
  }

  /** Run CP command text (e.g. "Show Herald") over rsh.  Needs no login. */
  async command(
    text: string,
    timeoutMs = 30_000,
  ): Promise<SessionCommandResult> {
    const start = Date.now();
    let r: { output: string; error?: string; timedOut?: boolean };
    try {
      r = await rshRunCommand(this.host, this.rshPort, text, { timeoutMs });
    } catch (e) {
      r = {
        output: "",
        error: `rsh ${this.host}:${this.rshPort}: ${errText(e)}`,
      };
    }
    const elapsedMs = Date.now() - start;
    this.note(
      `command ${JSON.stringify(text)}`,
      r.timedOut
        ? `TIMED OUT after ${elapsedMs}ms`
        : r.error !== undefined
        ? `error: ${r.error.split("\n")[0]}`
        : `${r.output.length} chars in ${elapsedMs}ms`,
    );
    return { ...r, elapsedMs };
  }

  /** Resize the grid and, when logged in, tell Genera the new size. */
  async resize(cols: number, rows: number): Promise<void> {
    const [, c, r] = encodeSize(cols, rows);
    this.screen.resize(c, r);
    if (this.connected) await this.#send(encodeSize(c, r));
    this.note(`resize ${c}x${r}`, this.connected ? "sent" : "local only");
  }
}

// ---------------------------------------------------------------------------
// MCP result rendering — deliberately terse
// ---------------------------------------------------------------------------
//
// Every tool result used to be pretty-printed JSON carrying the action log
// entry, the full session state and the whole 24x80 grid — roughly 400 tokens
// per call, most of it unchanged from the call before.  The rules now:
//
//   * results are plain text, not JSON (no quoting, no \n escaping, no indent);
//   * the screen is emitted as a diff against what the caller was last shown,
//     so a repaint costs the grid and a one-line answer costs one line;
//   * state collapses to a one-line footer; the full dump moved to a tool of
//     its own, so nothing is lost — it is just no longer paid for every call.

export type ScreenMode = "auto" | "full" | "changed" | "none";

/** Drop blank rows at both ends; interior blank rows are content. */
export function trimBlankEdges(lines: string[]): string[] {
  let a = 0, b = lines.length;
  while (a < b && lines[a] === "") a++;
  while (b > a && lines[b - 1] === "") b--;
  return lines.slice(a, b);
}

/**
 * Renders the grid against the last version the caller actually saw.
 *
 * "auto" picks per call: unchanged → a one-liner, a few changed rows → those
 * rows with 0-based row numbers, otherwise the whole screen.  Modes that emit
 * nothing leave the baseline alone — the caller has not seen those lines, so
 * the next diff must still be measured from the last screen they did see.
 *
 * "full" is the escape hatch and is answered literally: a caller who asks for
 * the whole grid has decided the diff is not what they need — typically a new
 * caller with no baseline, or one diagnosing a stall — so the unchanged
 * short-circuit must not swallow it.
 */
export class ScreenRenderer {
  #last: string[] | null = null;

  reset(): void {
    this.#last = null;
  }

  render(lines: string[], mode: ScreenMode = "auto"): string | null {
    if (mode === "none") return null;
    const prev = this.#last;
    this.#last = lines.slice();

    const full = trimBlankEdges(lines).join("\n");
    if (mode === "full") return full;

    if (
      prev && prev.length === lines.length &&
      prev.every((l, i) => l === lines[i])
    ) {
      return "(screen unchanged)";
    }

    if (!prev) return full;

    const changed: number[] = [];
    const n = Math.max(prev.length, lines.length);
    for (let i = 0; i < n; i++) {
      if ((prev[i] ?? "") !== (lines[i] ?? "")) changed.push(i);
    }
    const diff = "changed:\n" +
      changed.map((i) => `${String(i).padStart(2)}| ${lines[i] ?? ""}`)
        .join("\n");
    // Cheapest faithful rendering wins; "changed" forces the diff regardless.
    if (mode === "changed" || diff.length < full.length) return diff;
    return full;
  }
}

/**
 * Long output, head- and tail-biased: a Listener transcript keeps its value on
 * the last line, so a plain head truncation would drop the very thing asked
 * for.  Returns the text unchanged when it fits.
 */
export function clampLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (max <= 0 || lines.length <= max) return text;
  const head = Math.min(20, Math.floor(max / 4));
  const tail = max - head;
  const omitted = lines.length - max;
  return [
    ...lines.slice(0, head),
    `... ${omitted} lines omitted (raise max_lines) ...`,
    ...lines.slice(lines.length - tail),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Eval / command results as text
// ---------------------------------------------------------------------------

/**
 * Plain-text rendering of an eval result: what the form printed, then one
 * `=> value` line per value, or the error.  Shared by MCP and the CLI.
 */
export function formatEval(r: EvalResult & { elapsedMs?: number }): string {
  const parts: string[] = [];
  const out = r.output.replace(/^\n/, "").replace(/\s+$/, "");
  if (out) parts.push(out);
  if (r.timedOut) {
    parts.push(
      `TIMED OUT${
        r.elapsedMs !== undefined ? ` after ${r.elapsedMs}ms` : ""
      } (only our socket was closed; the form may still be running in Genera)`,
    );
  } else if (r.error !== undefined) {
    parts.push(`error: ${r.error}`);
  } else if (r.values && r.values.length) {
    for (const v of r.values) parts.push(`=> ${v}`);
  } else {
    parts.push("=> (no values)");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// MCP stdio server
// ---------------------------------------------------------------------------
//
// The SDK is imported dynamically so that the session and codecs stay
// dependency-free: `deno test` never pulls npm, and a bad SDK can only break
// the MCP entry point, not the core.

/** Pin the SDK version we verified in the Deno cache. */
const MCP_SDK = "npm:@modelcontextprotocol/sdk@1.29.0";
const ZOD = "npm:zod@3.25.76";

export async function runMcpServer(session: GeneraSession): Promise<void> {
  const { McpServer } = await import(`${MCP_SDK}/server/mcp.js`);
  const { StdioServerTransport } = await import(`${MCP_SDK}/server/stdio.js`);
  const { z } = await import(ZOD);

  const server = new McpServer({ name: "genera-remote", version: "2.0.0" });
  const rendered = new ScreenRenderer();

  /** Text result; empty/absent parts drop out. */
  const reply = (parts: Array<string | null | undefined>, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{
      type: "text" as const,
      text: parts.filter((p) => p !== null && p !== undefined && p !== "")
        .join("\n"),
    }],
  });

  /**
   * Exceptions only.  The nominal case — connected, sitting at a prompt — has
   * nothing worth saying, so it says nothing; cursor, host/ports and the rest
   * live in genera_state.  "no-prompt" is kept because it is the one bit a
   * caller must act on: either Genera has not come back yet, or an input
   * line is still open.
   */
  const footer = (...extra: string[]) => {
    const bits = [...extra];
    if (!session.connected) bits.push("DISCONNECTED");
    else if (!bits.length && !session.atPrompt()) bits.push("no-prompt");
    return bits.length ? `[${bits.join(" ")}]` : null;
  };

  const screenOf = (mode: ScreenMode) =>
    rendered.render(session.screen.lines(), mode);

  const fail = (message: string) =>
    reply([`error: ${message}`, footer()], true);

  const modeArg = (def: ScreenMode) =>
    z.enum(["auto", "full", "changed", "none"]).optional().describe(
      `screen rendering: auto = diff vs what you last saw, full = whole grid, changed = rows only, none = omit (default ${def})`,
    );

  // Typing and pressing a key return the screen the echo has yet to reach, so
  // they settle briefly first.  One slightly slower call beats a call plus a
  // genera_wait to see its effect.
  const settleArg = z.number().int().optional().describe(
    "ms of quiet to wait for before reading the screen (default 300, 0 = read immediately)",
  );
  const settle = async (ms?: number) => {
    const q = ms ?? 300;
    if (q > 0) {
      await session.wait({ stableMs: q, timeoutMs: Math.max(q * 8, 2000) });
    }
  };

  const maxLinesArg = z.number().int().optional().describe(
    "truncate past this many lines, keeping head and tail (default 200, 0 = unlimited)",
  );
  const timeoutArg = z.number().int().optional().describe(
    "give up after this many ms (default 30000); only our socket closes, the work keeps running in Genera",
  );

  // Everything but connect/state/log is listed only while the login is up:
  // before that the tools have nothing to act on.  The SDK drops a disabled
  // tool from tools/list and sends notifications/tools/list_changed on every
  // toggle, so the client's tool list follows the connection.
  // deno-lint-ignore no-explicit-any
  const gated: any[] = [];
  // deno-lint-ignore no-explicit-any
  const registerGated = (...args: any[]) => {
    const tool = server.registerTool(...args);
    if (!session.connected) tool.disable();
    gated.push(tool);
  };
  session.onConnectionChange = (up) => {
    for (const tool of gated) up ? tool.enable() : tool.disable();
  };

  server.registerTool("genera_connect", {
    title: "Log in to Genera",
    description:
      `Open a 3600-LOGIN session (Genera's native remote terminal, TCP ${DEFAULT_LOGIN_PORT}) and return the screen. The other genera_* tools (screen, type, key, wait, eval, command, disconnect) appear only once this succeeds, and go away again when the session ends. When already connected, cols/rows resize the live session.`,
    inputSchema: {
      host: z.string().optional().describe(`host (default ${session.host})`),
      port: z.number().int().optional().describe(
        `login port (default ${session.loginPort})`,
      ),
      cols: z.number().int().optional().describe(
        `columns (default ${session.screen.cols})`,
      ),
      rows: z.number().int().optional().describe(
        `rows (default ${session.screen.rows})`,
      ),
    },
  }, async (
    { host, port, cols, rows }: {
      host?: string;
      port?: number;
      cols?: number;
      rows?: number;
    },
  ) => {
    if (session.connected) {
      if (cols === undefined && rows === undefined) {
        return reply([
          `already connected to ${session.host}:${session.loginPort}`,
          screenOf("auto"),
          footer(),
        ]);
      }
      try {
        await session.resize(
          cols ?? session.screen.cols,
          rows ?? session.screen.rows,
        );
      } catch (e) {
        return fail(errText(e));
      }
      await settle(400);
      return reply([
        `resized to ${session.screen.cols}x${session.screen.rows}`,
        screenOf("auto"),
        footer(),
      ]);
    }
    const entry = await session.connect(host, port, { cols, rows });
    if (!session.connected) return fail(entry.outcome);
    // The herald paints only after the server's init window.
    await session.awaitHerald();
    session.note("connect", "settled");
    rendered.reset(); // fresh login: the caller has seen nothing yet
    return reply([screenOf("full"), footer()]);
  });

  registerGated("genera_disconnect", {
    title: "Log out",
    description: "Send logout on the 3600-LOGIN session and close it.",
    inputSchema: {},
  }, async () => {
    const entry = await session.disconnect();
    rendered.reset();
    return reply([entry.outcome]);
  });

  registerGated("genera_screen", {
    title: "Read the screen",
    description:
      "Return the character grid as text. By default only what changed since the screen you were last shown; pass mode=full for the whole grid.",
    inputSchema: { mode: modeArg("auto") },
  }, ({ mode }: { mode?: ScreenMode }) => {
    session.note("screen", "read");
    return reply([screenOf(mode ?? "auto"), footer()]);
  });

  registerGated("genera_type", {
    title: "Type text",
    description:
      "Type text on the 3600 session (no Return appended). Printable ASCII as is; a newline is Return, a tab is Tab; SAIL glyphs such as λ or ≠ type their Genera characters. The Listener runs a form as soon as its closing paren is typed, so a form needs no Return.",
    inputSchema: {
      text: z.string().describe("text to type"),
      mode: modeArg("auto"),
      settle_ms: settleArg,
    },
  }, async (
    { text, mode, settle_ms }: {
      text: string;
      mode?: ScreenMode;
      settle_ms?: number;
    },
  ) => {
    try {
      await session.type(text);
      await settle(settle_ms);
      return reply([screenOf(mode ?? "auto"), footer()]);
    } catch (e) {
      return fail(errText(e));
    }
  });

  registerGated("genera_key", {
    title: "Press a key",
    description:
      `Press one Genera key on the 3600 session. Grammar: optional prefixes c- m- s- h- (control, meta, super, hyper) and sh- (shift a letter), then a single character or a key name: ${
        keyNames().join(", ")
      }. Examples: Return, c-m-Abort, m-X, c-sh-a, Select.`,
    inputSchema: {
      name: z.string().describe("key spec, e.g. Return, Abort, c-m-Abort, m-X"),
      mode: modeArg("auto"),
      settle_ms: settleArg,
    },
  }, async (
    { name, mode, settle_ms }: {
      name: string;
      mode?: ScreenMode;
      settle_ms?: number;
    },
  ) => {
    try {
      await session.key(name);
      await settle(settle_ms);
      return reply([screenOf(mode ?? "auto"), footer()]);
    } catch (e) {
      return fail(errText(e));
    }
  });

  registerGated(
    "genera_wait",
    {
      title: "Wait for the screen",
      description:
        "Wait until a regex appears on screen, OR the screen is unchanged for stable_ms. Returns the screen (diffed by default). Fails closed on timeout.",
      inputSchema: {
        pattern: z.string().optional().describe("regex to wait for"),
        stable_ms: z.number().int().optional().describe(
          "ms of no change to accept",
        ),
        timeout_ms: z.number().int().optional().describe(
          "give up after this many ms",
        ),
        mode: modeArg("auto"),
      },
    },
    async (
      { pattern, stable_ms, timeout_ms, mode }: {
        pattern?: string;
        stable_ms?: number;
        timeout_ms?: number;
        mode?: ScreenMode;
      },
    ) => {
      if (!session.connected) return fail("not connected");
      const r = await session.wait({
        pattern,
        stableMs: stable_ms,
        timeoutMs: timeout_ms,
      });
      const verdict = r.matched
        ? "matched"
        : r.stable
        ? "settled"
        : "TIMED OUT";
      session.note(
        `wait ${pattern ? JSON.stringify(pattern) : "(stable)"}`,
        verdict,
      );
      // Silent when the wait did what was asked; loud when it did not — a
      // pattern that never matched is a settled screen, not a success.
      const notes = r.timedOut
        ? [`TIMED OUT ${r.elapsedMs}ms`]
        : pattern !== undefined && !r.matched
        ? [`no match, settled ${r.elapsedMs}ms`]
        : [];
      return reply([screenOf(mode ?? "auto"), footer(...notes)], r.timedOut);
    },
  );

  registerGated("genera_eval", {
    title: "Evaluate a form",
    description:
      `Evaluate ONE Lisp form over rsh (TCP ${session.rshPort}; read in CL-USER) and return what it printed, then one "=> value" line per value (printed with ~S), or "error: ..." with the error report. Nothing is lost to the screen size.`,
    inputSchema: {
      form: z.string().describe(
        "a single form; wrap several in (progn ...)",
      ),
      timeout_ms: timeoutArg,
      max_lines: maxLinesArg,
    },
  }, async (
    { form, timeout_ms, max_lines }: {
      form: string;
      timeout_ms?: number;
      max_lines?: number;
    },
  ) => {
    const r = await session.evalForm(form, timeout_ms ?? 30_000);
    return reply(
      [clampLines(formatEval(r), max_lines ?? 200)],
      r.error !== undefined || !!r.timedOut,
    );
  });

  registerGated("genera_command", {
    title: "Run a CP command",
    description:
      `Run Command Processor text (e.g. "Show Herald", "Show Users") over rsh (TCP ${session.rshPort}) and return its output. A command's own error report comes back as ordinary output.`,
    inputSchema: {
      text: z.string().describe("the command line, as typed at Command:"),
      timeout_ms: timeoutArg,
      max_lines: maxLinesArg,
    },
  }, async (
    { text, timeout_ms, max_lines }: {
      text: string;
      timeout_ms?: number;
      max_lines?: number;
    },
  ) => {
    const r = await session.command(text, timeout_ms ?? 30_000);
    const out = r.output.replace(/^\n/, "").replace(/\s+$/, "");
    const tail = r.timedOut
      ? `TIMED OUT after ${r.elapsedMs}ms (only our socket was closed)`
      : r.error !== undefined
      ? `error: ${r.error}`
      : out
      ? null
      : "(no output)";
    return reply(
      [clampLines([out, tail].filter(Boolean).join("\n"), max_lines ?? 200)],
      r.error !== undefined,
    );
  });

  server.registerTool("genera_state", {
    title: "Session state",
    description:
      "Full session state as JSON: login connection, ports, screen size, cursor, prompt. Other tools report only a one-line summary; call this when that is not enough.",
    inputSchema: {},
  }, () => reply([JSON.stringify(session.state())]));

  server.registerTool("genera_log", {
    title: "Session action log",
    description:
      "Return the in-memory action log, one line per entry (time, intent, outcome).",
    inputSchema: {
      limit: z.number().int().optional().describe(
        "last N entries (default 20, 0 = all)",
      ),
    },
  }, ({ limit }: { limit?: number }) => {
    const n = limit ?? 20;
    const log = n > 0 ? session.actionLog.slice(-n) : session.actionLog.slice();
    return reply([
      log.map((e) => `${e.time.slice(11, 19)} ${e.intent} -> ${e.outcome}`)
        .join("\n"),
    ]);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive; the transport resolves connect() immediately.
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    try {
      Deno.addSignalListener("SIGINT", shutdown);
      Deno.addSignalListener("SIGTERM", shutdown);
    } catch (_e) { /* signals unavailable; rely on stdin EOF */ }
  });
  if (session.connected) await session.disconnect();
}

// ---------------------------------------------------------------------------
// repl: an interactive full-screen 3600 terminal
// ---------------------------------------------------------------------------

export const ANSI_AUTOWRAP_OFF = "\x1b[?7l";
export const ANSI_AUTOWRAP_ON = "\x1b[?7h";

const ESCAPE_KEY = 0x1d; // Ctrl-]: local escape, like telnet's
const C = 1, M = 2; // control, meta bits

const key = (name: string, bits = 0) => encodeChar(KEY_CODES[name], bits);
const ctl = (ch: string) => encodeChar(ch.charCodeAt(0), C);
const meta = (ch: string) => encodeChar(ch.charCodeAt(0), M);

/** CSI/SS3 final byte (no numeric parameter) -> key bytes. */
const CSI_FINAL: Record<string, readonly number[]> = {
  A: ctl("P"), // up
  B: ctl("N"), // down
  C: ctl("F"), // right
  D: ctl("B"), // left
  H: meta("<"), // Home
  F: key("End"), // End
  P: key("Help"), // F1 (SS3 P / CSI 1;mP)
  Q: key("Suspend"), // F2
  R: key("Resume"), // F3
  S: key("Abort"), // F4
};

/** CSI n ~ -> key bytes. */
const CSI_TILDE: Record<number, readonly number[]> = {
  1: meta("<"), // Home
  7: meta("<"),
  4: key("End"), // End
  8: key("End"),
  5: meta("V"), // PgUp
  6: ctl("V"), // PgDn
  11: key("Help"), // F1
  12: key("Suspend"), // F2
  13: key("Resume"), // F3
  14: key("Abort"), // F4
  15: key("Refresh"), // F5
  17: key("Clear-Input"), // F6
  18: key("Function"), // F7
  19: key("End"), // F8
  20: key("Network"), // F9
};

/** Ctrl-] menu: next key -> bytes to send. */
const MENU: Record<string, readonly number[]> = {
  h: key("Help"),
  a: key("Abort"),
  e: key("End"),
  s: key("Suspend"),
  r: key("Resume"),
  c: key("Clear-Input"),
  f: key("Function"),
  n: key("Network"),
  l: key("Refresh"),
  x: key("Complete"),
  S: key("Select"),
  [String.fromCharCode(ESCAPE_KEY)]: ctl("]"),
};

export const MENU_HELP = [
  "genera-remote escape (Ctrl-]) commands:",
  "  q       quit (log out and close)",
  "  h       Help           a  Abort",
  "  e       End            s  Suspend",
  "  r       Resume         c  Clear-Input",
  "  f       Function       n  Network",
  "  l       Refresh        x  Complete",
  "  S       Select         ?  this list",
  "  Ctrl-]  send c-]",
  "Other keys: Return, Rubout (Delete), Tab; Ctrl-letter = c-letter;",
  "Esc-prefix/Option = Meta; arrows = c-P/c-N/c-F/c-B; Home = m-<,",
  "End = End, PgUp/PgDn = m-V/c-V; F1 Help, F2 Suspend, F3 Resume,",
  "F4 Abort, F5 Refresh, F6 Clear-Input, F7 Function, F8 End, F9 Network.",
].join("\r\n");

export interface KeyResult {
  /** Bytes to send to Genera. */
  bytes: Uint8Array;
  /** The user asked to quit (logout bytes are already in `bytes`). */
  quit: boolean;
  /** The user asked for the local escape-menu help. */
  help: boolean;
}

/**
 * Encode one local ASCII byte with extra bucky bits (0 or meta).  Return,
 * Rubout and Tab are Genera keys of their own; any other control byte is
 * control + the uppercase character, so Ctrl-H is c-H (not Backspace).
 * Letters with bits follow Genera's rule: unshifted sends the uppercase
 * code, shifted the lowercase.
 */
function encodeByte(b: number, extra: number): number[] {
  if (b === 0x0d) return key("Return", extra);
  if (b === 0x7f) return key("Rubout", extra);
  if (b === 0x09) return key("Tab", extra);
  if (b === 0x1b) return key("Escape", extra);
  if (b < 0x20) return encodeChar(b + 0x40, C | extra);
  if (!extra) return encodeChar(b);
  const isLetter = /[A-Za-z]/.test(String.fromCharCode(b));
  return encodeChar(isLetter ? b ^ 0x20 : b, extra);
}

/** Bytes in the UTF-8 sequence that starts with `lead`. */
function utf8Length(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

/**
 * Stateful key encoder for the local tty.  The only state carried between
 * reads is "Ctrl-] was the last key"; ESC-as-Meta and CSI parsing work
 * within one read, as a terminal delivers a whole key sequence in one write.
 */
export class KeyEncoder3600 {
  #menu = false;

  feed(chunk: Uint8Array): KeyResult {
    const out: number[] = [];
    let quit = false, help = false;
    let i = 0;
    while (i < chunk.length && !quit) {
      const b = chunk[i];
      if (this.#menu) {
        this.#menu = false;
        i++;
        const k = String.fromCharCode(b);
        if (k === "q" || k === "Q") {
          out.push(...LOGOUT);
          quit = true;
        } else if (k === "?") help = true;
        else if (MENU[k]) out.push(...MENU[k]);
        continue;
      }
      if (b === ESCAPE_KEY) {
        this.#menu = true;
        i++;
        continue;
      }
      if (b >= 0x80) {
        // UTF-8: a SAIL glyph types its Genera character; anything else
        // has no Genera code and is dropped.
        const n = utf8Length(b);
        const ch = new TextDecoder().decode(chunk.subarray(i, i + n));
        try {
          out.push(...encodeText(ch));
        } catch { /* no Genera code */ }
        i += n;
        continue;
      }
      if (b !== 0x1b) {
        out.push(...encodeByte(b, 0));
        i++;
        continue;
      }
      // ESC: lone (Escape), CSI/SS3, or Meta prefix.
      if (i + 1 >= chunk.length) {
        out.push(...key("Escape"));
        i++;
        continue;
      }
      const n = chunk[i + 1];
      if ((n === 0x5b || n === 0x4f) && i + 2 < chunk.length) {
        // CSI (ESC [) or SS3 (ESC O): params 0x30-0x3F, intermediates
        // 0x20-0x2F, final 0x40-0x7E.
        let j = i + 2;
        while (j < chunk.length && chunk[j] >= 0x20 && chunk[j] <= 0x3f) j++;
        if (j >= chunk.length) break; // truncated: drop the rest
        const final = String.fromCharCode(chunk[j]);
        const params = new TextDecoder().decode(chunk.subarray(i + 2, j));
        out.push(...lookupSequence(final, params));
        i = j + 1;
        continue;
      }
      // Meta prefix (Option-as-Meta).
      if (n === ESCAPE_KEY) out.push(...encodeChar(0x5d, C | M)); // c-m-]
      else if (n < 0x80) out.push(...encodeByte(n, M));
      i += 2;
    }
    return { bytes: new Uint8Array(out), quit, help };
  }
}

/** Map a CSI/SS3 sequence to key bytes; unknown sequences map to nothing. */
function lookupSequence(final: string, params: string): readonly number[] {
  if (final === "~") {
    const n = parseInt(params.split(";")[0], 10);
    return CSI_TILDE[n] ?? [];
  }
  return CSI_FINAL[final] ?? [];
}

/** Convenience: encode a whole string/bytes with a fresh encoder. */
export function encodeKeys(input: string | Uint8Array): KeyResult {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  return new KeyEncoder3600().feed(bytes);
}

export interface TerminalIO {
  /** The TCP connection (or a fake). */
  net: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  /** Local keyboard bytes (the raw tty), or null for none. */
  keys: ReadableStream<Uint8Array> | null;
  /** Receives the rendered xterm output. */
  write: (s: string) => void | Promise<void>;
  /** Local notices (the escape-menu help); written to stderr by the CLI. */
  note: (s: string) => void;
  cols: number;
  rows: number;
}

/**
 * One interactive 3600-LOGIN session: sends the size, then pumps both
 * directions through `ansiSink` and `KeyEncoder3600` until the server
 * closes or the user quits.  `resize` sends a live size change.
 */
export class Terminal3600 {
  #io: TerminalIO;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #sending: Promise<void> = Promise.resolve();

  constructor(io: TerminalIO) {
    this.#io = io;
  }

  #send(bytes: ArrayLike<number>): Promise<void> {
    const w = this.#writer;
    if (!w) return Promise.resolve();
    const data = Uint8Array.from(bytes);
    const p = this.#sending.then(() => w.write(data));
    this.#sending = p.catch(() => {});
    return p;
  }

  /** Tell Genera the window is now cols x rows. */
  resize(cols: number, rows: number): Promise<void> {
    return this.#send(encodeSize(cols, rows));
  }

  async run(): Promise<"closed" | "quit"> {
    const io = this.#io;
    const writer = io.net.writable.getWriter();
    this.#writer = writer;
    await this.#send(encodeSize(io.cols, io.rows));

    let done = false;
    let keyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const netReader = io.net.readable.getReader();

    const fromNet = (async () => {
      const dec = new Decoder3600();
      let text = "";
      const sink = ansiSink((s) => {
        text += s;
      });
      try {
        while (true) {
          const { value, done: eof } = await netReader.read();
          if (eof || !value) break;
          for (const op of dec.feed(value)) sink(op);
          if (text) {
            const s = text;
            text = "";
            await io.write(s);
          }
        }
      } catch (e) {
        if (!done) throw e;
      }
      return "closed" as const;
    })();

    const fromKeys = (async () => {
      if (!io.keys) return new Promise<never>(() => {});
      keyReader = io.keys.getReader();
      const enc = new KeyEncoder3600();
      while (true) {
        const { value, done: eof } = await keyReader.read();
        if (eof || !value) return new Promise<never>(() => {}); // keep net open
        const r = enc.feed(value);
        if (r.bytes.length) await this.#send(r.bytes);
        if (r.help) {
          io.note(
            `\r\n${MENU_HELP}\r\n(Type Ctrl-] l to have Genera refresh the screen.)\r\n`,
          );
        }
        if (r.quit) return "quit" as const;
      }
    })();

    const how = await Promise.race([fromNet, fromKeys]);
    done = true;
    this.#writer = null;
    try {
      await this.#sending;
      await writer.close();
    } catch { /* already closed */ }
    if (how === "quit") {
      try {
        await netReader.cancel();
      } catch { /* ignore */ }
    }
    try {
      await (keyReader as ReadableStreamDefaultReader<Uint8Array> | null)
        ?.cancel();
    } catch { /* ignore */ }
    return how;
  }
}

const encoder = new TextEncoder();
const stderr = (s: string) => Deno.stderr.writeSync(encoder.encode(s));

async function cliRepl(opts: CliOpts): Promise<number> {
  let rows = 24, cols = 80;
  try {
    ({ rows, columns: cols } = Deno.consoleSize());
  } catch { /* not a tty: keep 80x24 */ }

  let conn: Deno.TcpConn;
  try {
    conn = await Deno.connect({
      hostname: opts.host,
      port: opts.loginPort,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (e) {
    stderr(
      e instanceof Deno.errors.ConnectionRefused
        ? `genera-remote: connection to ${opts.host} port ${opts.loginPort} refused.\n${LOGIN_REQUIREMENTS}\n`
        : `genera-remote: ${opts.host} port ${opts.loginPort}: ${errText(e)}\n`,
    );
    return 1;
  }
  stderr(
    `Connected to ${opts.host}. Escape character is '^]' (^] ? for help).\r\n`,
  );

  const isTty = Deno.stdin.isTerminal();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      Deno.stdout.writeSync(encoder.encode(ANSI_AUTOWRAP_ON));
    } catch { /* ignore */ }
    if (isTty) {
      try {
        Deno.stdin.setRaw(false);
      } catch { /* ignore */ }
    }
  };

  const term = new Terminal3600({
    net: conn,
    keys: Deno.stdin.readable,
    write: (s) => {
      Deno.stdout.writeSync(encoder.encode(s));
    },
    note: stderr,
    rows,
    cols,
  });

  const onWinch = () => {
    try {
      const { rows, columns } = Deno.consoleSize();
      term.resize(columns, rows).catch(() => {});
    } catch { /* not a tty */ }
  };
  const onFatal = () => {
    restore();
    try {
      conn.close();
    } catch { /* ignore */ }
    Deno.exit(1);
  };
  const signals: Deno.Signal[] = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"];
  try {
    Deno.addSignalListener("SIGWINCH", onWinch);
  } catch { /* ignore */ }
  for (const s of signals) {
    try {
      Deno.addSignalListener(s, onFatal);
    } catch { /* ignore */ }
  }
  globalThis.addEventListener("unhandledrejection", restore);
  globalThis.addEventListener("unload", restore);

  let code = 0;
  try {
    if (isTty) Deno.stdin.setRaw(true);
    Deno.stdout.writeSync(encoder.encode(ANSI_AUTOWRAP_OFF));
    const how = await term.run();
    restore();
    stderr(how === "quit" ? "\nLogged out.\n" : "\nConnection closed.\n");
  } catch (e) {
    restore();
    stderr(`\ngenera-remote: ${errText(e)}\n`);
    code = 1;
  } finally {
    restore();
    try {
      Deno.removeSignalListener("SIGWINCH", onWinch);
    } catch { /* ignore */ }
    try {
      conn.close();
    } catch { /* ignore */ }
  }
  return code;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOpts {
  host: string;
  loginPort: number;
  rshPort: number;
  json: boolean;
  pattern?: string;
  stableMs?: number;
  timeoutMs?: number;
  rest: string[];
}

function envPort(name: string, def: number): number {
  const v = Deno.env.get(name);
  return v ? parseInt(v, 10) : def;
}

function parseCli(argv: string[]): { verb: string; opts: CliOpts } {
  const rest: string[] = [];
  const opts: CliOpts = {
    host: Deno.env.get("GENERA_HOST") ?? DEFAULT_HOST,
    loginPort: envPort("GENERA_LOGIN_PORT", DEFAULT_LOGIN_PORT),
    rshPort: envPort("GENERA_RSH_PORT", DEFAULT_RSH_PORT),
    json: false,
    rest,
  };
  let verb = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") opts.host = argv[++i];
    else if (a === "--login-port") opts.loginPort = parseInt(argv[++i], 10);
    else if (a === "--rsh-port") opts.rshPort = parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--pattern") opts.pattern = argv[++i];
    else if (a === "--stable-ms") opts.stableMs = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") opts.timeoutMs = parseInt(argv[++i], 10);
    else if (!verb) verb = a;
    else rest.push(a);
  }
  return { verb, opts };
}

const CLI_USAGE =
  `genera-remote — drive Genera over rsh and its 3600-LOGIN remote terminal

USAGE:
  genera-remote.ts <verb> [args] [--host H] [--login-port N] [--rsh-port N] [--json]

VERBS (rsh; no login):
  eval <form> [--timeout-ms N]     evaluate ONE form; prints output, then
                                   "=> value" lines.  Exit 1 on error, 2 on timeout
  command <text> [--timeout-ms N]  run a CP command, e.g. "Show Herald"

VERBS (3600-LOGIN; each logs in, acts, and logs out):
  screen                     print the screen after login
  type <text>                type text (a newline in it is Return)
  key <spec>...              press keys, e.g. Return c-m-Abort m-X Select
  wait [--pattern RE] [--stable-ms N] [--timeout-ms N]
  repl                       interactive full-screen terminal (Ctrl-] ? for help)

OTHER:
  keys                       list key names and their Genera codes
  mcp                        run as an MCP stdio server (default when no verb)

OPTIONS:
  --host H          default ${DEFAULT_HOST} (env GENERA_HOST)
  --login-port N    default ${DEFAULT_LOGIN_PORT} (env GENERA_LOGIN_PORT)
  --rsh-port N      default ${DEFAULT_RSH_PORT} (env GENERA_RSH_PORT)
  --json            machine-readable output where applicable

Key specs: optional c- m- s- h- (control meta super hyper) and sh- prefixes,
then one character or a key name ('keys' lists them).`;

async function cliMain(verb: string, opts: CliOpts): Promise<number> {
  const out = (s: string) => console.log(s);
  const session = new GeneraSession({
    host: opts.host,
    loginPort: opts.loginPort,
    rshPort: opts.rshPort,
  });

  const settle = () => session.wait({ stableMs: 400, timeoutMs: 4000 });

  switch (verb) {
    case "keys": {
      for (const n of keyNames()) {
        out(`${n.padEnd(14)} ${KEY_CODES[n].toString(8).padStart(3, "0")}`);
      }
      return 0;
    }
    case "repl":
      return await cliRepl(opts);
    case "eval": {
      const r = await session.evalForm(
        opts.rest.join(" "),
        opts.timeoutMs ?? 30_000,
      );
      if (opts.json) out(JSON.stringify(r, null, 2));
      else if (r.error !== undefined && !r.timedOut) {
        const printed = r.output.replace(/^\n/, "").replace(/\s+$/, "");
        if (printed) out(printed);
        console.error(`error: ${r.error}`);
      } else out(formatEval(r));
      return r.timedOut ? 2 : r.error !== undefined ? 1 : 0;
    }
    case "command": {
      const r = await session.command(
        opts.rest.join(" "),
        opts.timeoutMs ?? 30_000,
      );
      if (opts.json) out(JSON.stringify(r, null, 2));
      else {
        const printed = r.output.replace(/^\n/, "").replace(/\s+$/, "");
        if (printed) out(printed);
        if (r.timedOut) console.error(`TIMED OUT after ${r.elapsedMs}ms`);
        else if (r.error !== undefined) console.error(`error: ${r.error}`);
      }
      return r.timedOut ? 2 : r.error !== undefined ? 1 : 0;
    }
    case "screen":
    case "type":
    case "key":
    case "wait": {
      const entry = await session.connect();
      if (!session.connected) {
        console.error(`connect failed: ${entry.outcome}`);
        return 1;
      }
      await session.awaitHerald();
      let code = 0;
      let result: Record<string, unknown> = {};
      try {
        switch (verb) {
          case "type":
            await session.type(opts.rest.join(" "));
            await settle();
            break;
          case "key":
            if (!opts.rest.length) throw new Error("key: no key spec given");
            for (const spec of opts.rest) {
              await session.key(spec);
              await settle();
            }
            break;
          case "wait": {
            const r = await session.wait({
              pattern: opts.pattern,
              stableMs: opts.stableMs,
              timeoutMs: opts.timeoutMs,
            });
            result.wait = r;
            if (r.timedOut) code = 2;
            break;
          }
        }
      } catch (e) {
        console.error(errText(e));
        code = 1;
      }
      result = {
        ...result,
        screen: session.screen.text(),
        state: session.state(),
      };
      await session.disconnect();
      if (opts.json) out(JSON.stringify(result, null, 2));
      else out(String(result.screen));
      return code;
    }
    default:
      console.error(CLI_USAGE);
      return verb ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { verb, opts } = parseCli(Deno.args);
  if (verb === "" || verb === "mcp") {
    const session = new GeneraSession({
      host: opts.host,
      loginPort: opts.loginPort,
      rshPort: opts.rshPort,
    });
    await runMcpServer(session);
    Deno.exit(0);
  } else if (verb === "-h" || verb === "--help" || verb === "help") {
    console.log(CLI_USAGE);
    Deno.exit(0);
  } else {
    Deno.exit(await cliMain(verb, opts));
  }
}
