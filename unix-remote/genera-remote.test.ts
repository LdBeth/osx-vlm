#!/usr/bin/env -S deno test --allow-net --allow-env --allow-read --allow-run
/**
 * Tests for genera-remote.ts, run against the fake servers in
 * genera-remote-test.ts (no real VLM needed).  The codecs have their own
 * suites: genera-3600.test.ts and genera-rsh.test.ts.
 *
 *   deno test --allow-net --allow-env --allow-read --allow-run unix-remote/
 */

// Minimal assertion helpers — kept local so the test suite pulls no deps
// beyond the MCP SDK already in the Deno cache.
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}
function assertStringIncludes(haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `expected string to include ${JSON.stringify(needle)}; got ${
        JSON.stringify(haystack.slice(0, 300))
      }`,
    );
  }
}

import {
  checkForm,
  clampLines,
  DEFAULT_PROMPT_PATTERN,
  encodeKeys,
  formatEval,
  GeneraSession,
  KeyEncoder3600,
  LOGIN_REQUIREMENTS,
  ScreenRenderer,
  Terminal3600,
  tidyEvalError,
  trimBlankEdges,
} from "./genera-remote.ts";
import { KEY_CODES } from "./genera-3600.ts";

import {
  FAKE_PROMPT,
  FakeLoginServer,
  FakeRshServer,
} from "./genera-remote-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

/** A session logged in to a fresh fake, with the herald painted. */
async function loggedIn(
  opts: { cols?: number; rows?: number } = {},
): Promise<{ server: FakeLoginServer; s: GeneraSession }> {
  const server = new FakeLoginServer();
  server.listen();
  const s = new GeneraSession({
    host: server.hostname,
    loginPort: server.port,
    ...opts,
  });
  await s.connect();
  assert(s.connected, "connect failed");
  await s.awaitHerald(3000);
  return { server, s };
}

async function finish(server: FakeLoginServer, s: GeneraSession) {
  await s.disconnect();
  await waitFor(() => server.sessions.every((x) => x.closed), 2000);
  server.close();
}

const k = (code: number, bits = 0) => [3, bits, code];
const bytes = (input: string) => [...encodeKeys(input).bytes];

// ===========================================================================
// Session over 3600-LOGIN
// ===========================================================================

Deno.test("session: size goes first, herald renders as a golden screen", async () => {
  const { server, s } = await loggedIn({ cols: 72, rows: 20 });
  try {
    assertEquals(server.sessions[0].sizes, [{ cols: 72, rows: 20 }]);
    const golden = [
      "Symbolics System, FAKE:>initial.vlod",
      "Fake Virtual Lisp Machine",
      " Genera  9.0.8",
      "",
      "Command:",
    ].join("\n");
    assertEquals(s.screen.text(), golden);
    assert(s.atPrompt(), "cursor should be at the Command: prompt");
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: prompt pattern matches Genera-style prompts", () => {
  const re = DEFAULT_PROMPT_PATTERN;
  assert(re.test("Command: "));
  assert(re.test("Eval: "));
  assert(re.test("> "));
  assert(re.test("Some Frame > "));
  assert(!re.test("Command: (+ 1 2)"), "an unfinished form is not a prompt");
  assert(!re.test("loading..."));
});

Deno.test("session: a typed form is answered on the screen", async () => {
  const { server, s } = await loggedIn();
  try {
    await s.type("(* 6 7)");
    const r = await s.wait({ pattern: "42", timeoutMs: 3000 });
    assert(r.matched, "answer never appeared");
    await s.wait({ stableMs: 100, timeoutMs: 2000 });
    assertStringIncludes(s.screen.text(), `${FAKE_PROMPT}(* 6 7)\n42`);
    assert(s.atPrompt(), "should be back at a prompt");
    // Each typed character went over as 3, 0, code.
    const typed = server.sessions[0].input.map((i) => i.code);
    assertEquals(String.fromCharCode(...typed), "(* 6 7)");
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: newline types Return; Rubout erases", async () => {
  const { server, s } = await loggedIn();
  try {
    await s.type("xy");
    await s.key("Rubout");
    await s.type("\n");
    await waitFor(() => server.sessions[0].input.length === 4);
    assertEquals(
      server.sessions[0].input.map((i) => i.code),
      [0x78, 0x79, KEY_CODES.Rubout, KEY_CODES.Return],
    );
    await s.wait({ pattern: "Unbound: x", timeoutMs: 3000 });
    assertStringIncludes(s.screen.text(), "Unbound: x");
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: key sends bits and code", async () => {
  const { server, s } = await loggedIn();
  try {
    await s.key("c-m-Abort");
    await s.key("m-X");
    await s.key("Select");
    await waitFor(() => server.sessions[0].input.length === 3);
    assertEquals(server.sessions[0].input, [
      { bits: 3, code: KEY_CODES.Abort },
      { bits: 2, code: 0x58 },
      { bits: 0, code: KEY_CODES.Select },
    ]);
    let threw = "";
    try {
      await s.key("NoSuchKey");
    } catch (e) {
      threw = (e as Error).message;
    }
    assertStringIncludes(threw, "unknown key");
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: resize sends a live size message", async () => {
  const { server, s } = await loggedIn();
  try {
    await s.resize(100, 40);
    await waitFor(() => server.sessions[0].sizes.length === 2);
    assertEquals(server.sessions[0].sizes, [
      { cols: 80, rows: 24 },
      { cols: 100, rows: 40 },
    ]);
    assertEquals([s.screen.cols, s.screen.rows], [100, 40]);
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: disconnect sends logout", async () => {
  const { server, s } = await loggedIn();
  const entry = await s.disconnect();
  assertEquals(entry.outcome, "logged out");
  assert(!s.connected);
  await waitFor(() => server.sessions[0].closed);
  assert(server.sessions[0].loggedOut, "server never saw logout");
  assertEquals(server.sessions[0].protocolError, null);
  assertEquals(s.state().closeReason, "disconnected by us");
  server.close();
});

Deno.test("session: state has the new fields", async () => {
  const { server, s } = await loggedIn();
  try {
    const st = s.state();
    assertEquals(st.loginPort, server.port);
    assertEquals(st.rshPort, 514);
    assertEquals(st.connected, true);
    assertEquals(st.atPrompt, true);
    for (const gone of ["port", "terminalType", "serverEchoes"]) {
      assert(!(gone in st), `state still has ${gone}`);
    }
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: wait matches a pattern, and fails closed", async () => {
  const { server, s } = await loggedIn();
  try {
    const r = await s.wait({ pattern: "Genera +9\\.0", timeoutMs: 3000 });
    assert(r.matched);
    const r2 = await s.wait({ pattern: "NEVER_APPEARS", timeoutMs: 300 });
    assert(r2.timedOut);
    assert(!r2.matched);
  } finally {
    await finish(server, s);
  }
});

Deno.test("session: type before connect throws", async () => {
  const s = new GeneraSession();
  let threw = false;
  try {
    await s.type("hi");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("session: a refused login explains what Genera needs", async () => {
  // Grab a free port, then close it so nothing listens there.
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const s = new GeneraSession({ host: "127.0.0.1", loginPort: port });
  const entry = await s.connect();
  assert(!s.connected);
  assertStringIncludes(entry.outcome, "FAILED");
  assertStringIncludes(entry.outcome, LOGIN_REQUIREMENTS);
});

Deno.test("session: action log records intent and outcome", async () => {
  const { server, s } = await loggedIn();
  try {
    await s.type("x");
    assert(s.actionLog.length >= 2);
    const last = s.actionLog[s.actionLog.length - 1];
    assertEquals(last.intent, 'type "x"');
    assertEquals(last.outcome, "sent 1 chars");
  } finally {
    await finish(server, s);
  }
});

// ===========================================================================
// eval / command over rsh
// ===========================================================================

Deno.test("rsh: eval needs no login; values, output, errors", async () => {
  const rsh = new FakeRshServer();
  rsh.listen();
  try {
    const s = new GeneraSession({ host: rsh.hostname, rshPort: rsh.port });
    const a = await s.evalForm("(+ 1 2)", 3000);
    assertEquals(a.values, ["3"]);
    assertEquals(a.error, undefined);
    assertEquals(formatEval(a), "=> 3");

    const b = await s.evalForm("(progn (print 1) (values 2 3))", 3000);
    assertEquals(b.values, ["2", "3"]);
    assertEquals(formatEval(b), "1\n=> 2\n=> 3");

    const c = await s.evalForm("(car 5)", 3000);
    assertEquals(c.values, undefined);
    assertStringIncludes(c.error!, "CAR");
    assertStringIncludes(formatEval(c), "error: The first argument");

    const d = await s.evalForm("(foo) (bar", 3000);
    assertStringIncludes(d.error!, "unclosed");
    assertEquals(rsh.requests.length, 3, "a bad form must not be sent");

    assert(!s.connected, "eval must not log in");
    // user and password are sent, and ignored by Genera
    assertEquals(rsh.requests[0].slice(0, 3), ["0", "lispm", "lispm"]);
  } finally {
    rsh.close();
  }
});

Deno.test("rsh: eval timeout closes only our socket", async () => {
  const rsh = new FakeRshServer();
  rsh.listen();
  try {
    const s = new GeneraSession({ host: rsh.hostname, rshPort: rsh.port });
    const r = await s.evalForm("(loop)", 300);
    assert(r.timedOut, "expected a timeout");
    assertStringIncludes(formatEval(r), "TIMED OUT");
    assertStringIncludes(formatEval(r), "may still be running");
  } finally {
    rsh.close();
  }
});

Deno.test("rsh: command output, and a rejection with its hint", async () => {
  const rsh = new FakeRshServer();
  rsh.listen();
  try {
    const s = new GeneraSession({ host: rsh.hostname, rshPort: rsh.port });
    const r = await s.command("Show Herald", 3000);
    assertEquals(r.error, undefined);
    assertStringIncludes(r.output, "Genera 9.0.8");
    assertEquals(rsh.requests[0][3], "Show Herald");

    const busy = await s.command("busy", 3000);
    assertStringIncludes(busy.error!, "in use by LDBETH");
    assertStringIncludes(busy.error!, "EVAL-SERVER-ON");
  } finally {
    rsh.close();
  }
});

Deno.test("rsh: a refused port is an error, not a throw", async () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const s = new GeneraSession({ host: "127.0.0.1", rshPort: port });
  const r = await s.evalForm("(+ 1 2)", 2000);
  assertStringIncludes(r.error!, `rsh 127.0.0.1:${port}`);
});

Deno.test("tidyEvalError: the wrapper echo becomes the user's form", () => {
  // Captured live from Genera 9.0.8 for the form "(+ 1".
  const live = "End of file for #<CLI::STRING-INPUT-STREAM 1273157>.\n" +
    "End of file occurred while reading (CONDITIONS:HANDLER-CASE (LET ((V (MULTIPLE-VALUE-LIST (+ 1)))\n" +
    '                               (FORMAT T "RSHa52e735798699a49V~{~SRSHa52e735798699a49~}~%" V))\n' +
    '                           (ERROR (E) (FORMAT T "RSHa52e735798699a49E~A~%" E))))';
  const t = tidyEvalError(live, "(+ 1");
  assertEquals(
    t,
    "End of file for #<CLI::STRING-INPUT-STREAM 1273157>.\n" +
      "End of file occurred while reading (+ 1",
  );
  assert(!/RSH[0-9a-f]{16}/.test(t));

  const multi = "Incorrect arguments to MULTIPLE-VALUE-LIST:\n" +
    "The macro's argument pattern (SYS:FORM)\n" +
    "does not match the form (MULTIPLE-VALUE-LIST (+ 1 2) (+ 3 4)).";
  assertStringIncludes(tidyEvalError(multi, "(+ 1 2) (+ 3 4)"), "(progn");
  assertEquals(tidyEvalError("plain", "x"), "plain");
});

Deno.test("checkForm: parens, strings, escapes, comments", () => {
  assertEquals(checkForm("(+ 1 2)"), null);
  assertEquals(checkForm("'sym"), null);
  assertEquals(checkForm('(print ")(")'), null);
  assertEquals(checkForm("(list #\\( #\\))"), null);
  assertEquals(checkForm("(list '|a)b|) ; )))\n"), null);
  assertEquals(checkForm("#| ( |# (+ 1 2)"), null);
  assertStringIncludes(checkForm("(+ 1 2))")!, "extra ')'");
  assertStringIncludes(checkForm("(+ 1")!, "1 unclosed");
  assertStringIncludes(checkForm('(print "abc)')!, "unterminated");
  assertEquals(checkForm("  ; nothing\n"), "empty form");
});

// ===========================================================================
// repl key encoding
// ===========================================================================

Deno.test("keys: printable, Return, Rubout, Tab", () => {
  assertEquals(bytes("a("), [...k(0x61), ...k(0x28)]);
  assertEquals(bytes("\r"), k(KEY_CODES.Return));
  assertEquals(bytes("\x7f"), k(KEY_CODES.Rubout));
  assertEquals(bytes("\t"), k(KEY_CODES.Tab));
});

Deno.test("keys: Ctrl-letter is control + uppercase, c-H included", () => {
  assertEquals(bytes("\x01"), k(0x41, 1));
  assertEquals(bytes("\x08"), k(0x48, 1));
  assertEquals(bytes("\x0a"), k(0x4a, 1));
});

Deno.test("keys: ESC prefix is Meta within one chunk; lone ESC is Escape", () => {
  assertEquals(bytes("\x1bx"), k(0x58, 2)); // m-x: uppercase code
  assertEquals(bytes("\x1bX"), k(0x78, 2)); // m-sh-x
  assertEquals(bytes("\x1b<"), k(0x3c, 2));
  assertEquals(bytes("\x1b\x01"), k(0x41, 3)); // c-m-a
  assertEquals(bytes("\x1b\r"), k(KEY_CODES.Return, 2));
  assertEquals(bytes("\x1b"), k(KEY_CODES.Escape));
});

Deno.test("keys: arrows and function keys", () => {
  assertEquals(bytes("\x1b[A"), k(0x50, 1)); // c-P
  assertEquals(bytes("\x1b[B"), k(0x4e, 1)); // c-N
  assertEquals(bytes("\x1b[C"), k(0x46, 1)); // c-F
  assertEquals(bytes("\x1b[D"), k(0x42, 1)); // c-B
  assertEquals(bytes("\x1b[1;5A"), k(0x50, 1));
  const fkeys = [
    "\x1bOP",
    "\x1bOQ",
    "\x1bOR",
    "\x1bOS",
    "\x1b[15~",
    "\x1b[17~",
    "\x1b[18~",
    "\x1b[19~",
    "\x1b[20~",
  ];
  const names = [
    "Help",
    "Suspend",
    "Resume",
    "Abort",
    "Refresh",
    "Clear-Input",
    "Function",
    "End",
    "Network",
  ];
  fkeys.forEach((seq, i) =>
    assertEquals(bytes(seq), k(KEY_CODES[names[i]]), `F${i + 1}`)
  );
  assertEquals(bytes("\x1b[11~"), k(KEY_CODES.Help));
  assertEquals(bytes("\x1b[99~"), []);
});

Deno.test("keys: SAIL glyphs type their Genera codes; other UTF-8 drops", () => {
  assertEquals(bytes("λ"), k(8));
  assertEquals(bytes("≠"), k(26));
  assertEquals(bytes("é"), []);
});

Deno.test("keys: Ctrl-] menu", () => {
  const enc = new KeyEncoder3600();
  const menu = (c: string) => [...enc.feed(new TextEncoder().encode(c)).bytes];
  assertEquals(menu("\x1dh"), k(KEY_CODES.Help));
  assertEquals(menu("\x1da"), k(KEY_CODES.Abort));
  assertEquals(menu("\x1dx"), k(KEY_CODES.Complete));
  assertEquals(menu("\x1dS"), k(KEY_CODES.Select));
  assertEquals(menu("\x1d\x1d"), k(0x5d, 1)); // c-]
  // The menu key may arrive in the next read.
  assertEquals(menu("\x1d"), []);
  assertEquals(menu("f"), k(KEY_CODES.Function));
  const help = enc.feed(new TextEncoder().encode("\x1d?"));
  assert(help.help && !help.quit && help.bytes.length === 0);
  const q = enc.feed(new TextEncoder().encode("\x1dqjunk"));
  assert(q.quit);
  assertEquals([...q.bytes], [0]); // LOGOUT, and nothing after it
});

// ===========================================================================
// repl terminal against the fake login server
// ===========================================================================

Deno.test("terminal: size first, ANSI output, live resize, Ctrl-] q logs out", async () => {
  const server = new FakeLoginServer();
  server.listen();
  const conn = await Deno.connect({
    hostname: server.hostname,
    port: server.port,
  });
  let screen = "";
  let keysCtl!: ReadableStreamDefaultController<Uint8Array>;
  const keys = new ReadableStream<Uint8Array>({
    start(c) {
      keysCtl = c;
    },
  });
  const term = new Terminal3600({
    net: conn,
    keys,
    write: (s) => {
      screen += s;
    },
    note: () => {},
    cols: 80,
    rows: 24,
  });
  const run = term.run();
  try {
    assert(await waitFor(() => screen.includes(FAKE_PROMPT)), "no herald");
    assertStringIncludes(screen, "\x1b[H\x1b[2J"); // clear op
    assertStringIncludes(screen, "Fake Virtual Lisp Machine\r\n\x1b[2K");
    await term.resize(120, 50);
    keysCtl.enqueue(new TextEncoder().encode("(+ 1 2)"));
    assert(await waitFor(() => screen.includes("3\r\n")), "no answer");
    keysCtl.enqueue(new TextEncoder().encode("\x1dq"));
    assertEquals(await run, "quit");
    const sess = server.sessions[0];
    assert(await waitFor(() => sess.closed), "server session still open");
    assertEquals(sess.sizes, [{ cols: 80, rows: 24 }, { cols: 120, rows: 50 }]);
    assert(sess.loggedOut, "logout not received");
  } finally {
    try {
      conn.close();
    } catch { /* closed */ }
    server.close();
  }
});

// ===========================================================================
// MCP result rendering — what keeps tool results small
// ===========================================================================

Deno.test("render: blank edges go, interior blank rows stay", () => {
  assertEquals(
    trimBlankEdges(["", "", "a", "", "b", "", ""]),
    ["a", "", "b"],
  );
  assertEquals(trimBlankEdges(["", ""]), []);
});

Deno.test("render: first screen is full, an idle screen is one line", () => {
  const r = new ScreenRenderer();
  assertEquals(r.render(["", "hello", "world", ""]), "hello\nworld");
  assertEquals(r.render(["", "hello", "world", ""]), "(screen unchanged)");
});

Deno.test("render: mode full answers with the grid even when idle", () => {
  const r = new ScreenRenderer();
  r.render(["", "hello", "world", ""]);
  // "auto" is right to collapse this; "full" was asked for the grid.
  assertEquals(r.render(["", "hello", "world", ""]), "(screen unchanged)");
  assertEquals(r.render(["", "hello", "world", ""], "full"), "hello\nworld");
  // "changed" with nothing changed still has nothing to list.
  assertEquals(
    r.render(["", "hello", "world", ""], "changed"),
    "(screen unchanged)",
  );
});

Deno.test("render: a small change comes back as numbered rows", () => {
  const r = new ScreenRenderer();
  const base = Array.from({ length: 24 }, (_, i) => `row ${i} filler text`);
  r.render(base);
  const next = base.slice();
  next[7] = "Command: (* 6 7)";
  assertEquals(r.render(next), "changed:\n 7| Command: (* 6 7)");
});

Deno.test("render: a repainted screen falls back to the full grid", () => {
  const r = new ScreenRenderer();
  r.render(Array.from({ length: 24 }, (_, i) => `old ${i}`));
  const fresh = Array.from({ length: 24 }, (_, i) => `new ${i}`);
  const out = r.render(fresh)!;
  assert(!out.startsWith("changed:"), "expected the full grid, got a diff");
  assertEquals(out.split("\n").length, 24);
});

Deno.test("render: mode none emits nothing and keeps the baseline", () => {
  const r = new ScreenRenderer();
  r.render(["a"]);
  assertEquals(r.render(["b"], "none"), null);
  // The caller never saw "b", so "b" must still read as a change.
  assertEquals(r.render(["b"]), "b");
});

Deno.test("render: long output keeps its head and its tail", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  assertEquals(clampLines(text, 0), text);
  assertEquals(clampLines("short", 200), "short");
  const out = clampLines(text, 100).split("\n");
  assertEquals(out.length, 101); // 100 kept + the omission marker
  assertEquals(out[0], "line 0");
  assertEquals(out[out.length - 1], "line 499");
  assertStringIncludes(out[20], "400 lines omitted");
});

// ===========================================================================
// MCP: real SDK transport, one round trip
// ===========================================================================

Deno.test({
  name: "mcp: handshake and tools/call round trips",
  // Spawns a child Deno running the MCP server; needs run permission, and the
  // SDK must already be in the npm cache (offline).
  permissions: { net: true, env: true, read: true, run: true },
  async fn() {
    // Fake Genera services the MCP server can reach.
    const login = new FakeLoginServer();
    login.listen();
    const rsh = new FakeRshServer();
    rsh.listen();

    const { Client } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/index.js"
    );
    const { StdioClientTransport } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/stdio.js"
    );

    const { ToolListChangedNotificationSchema } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/types.js"
    );

    const here = new URL(".", import.meta.url).pathname;
    const transport = new StdioClientTransport({
      command: Deno.execPath(),
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        `${here}genera-remote.ts`,
        "mcp",
      ],
      env: {
        GENERA_HOST: login.hostname,
        GENERA_LOGIN_PORT: String(login.port),
        GENERA_RSH_PORT: String(rsh.port),
      },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    let listChanges = 0;
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      () => void listChanges++,
    );
    const text = (res: unknown) =>
      (res as { content: Array<{ type: string; text: string }> }).content[0]
        .text;
    const toolNames = async () =>
      ((await client.listTools()).tools as Array<{ name: string }>)
        .map((t) => t.name).sort();
    const OFFLINE = ["genera_connect", "genera_log", "genera_state"];
    try {
      await client.connect(transport);

      // Before a login only connect/state/log are offered.
      assertEquals(await toolNames(), OFFLINE);
      let refused = false;
      try {
        const r = await client.callTool({
          name: "genera_eval",
          arguments: { form: "(* 6 7)" },
        });
        refused = !!(r as { isError?: boolean }).isError;
      } catch {
        refused = true;
      }
      assert(refused, "a hidden tool must not run");
      assertEquals(rsh.requests.length, 0, "hidden eval reached rsh");

      const connectRes = await client.callTool({
        name: "genera_connect",
        arguments: {},
      });
      assertStringIncludes(text(connectRes), "Fake Virtual Lisp Machine");
      assertEquals(login.sessions[0].sizes, [{ cols: 80, rows: 24 }]);

      // Logged in: the rest appear, and the client was told.
      assert(await waitFor(() => listChanges > 0), "no tools/list_changed");
      assertEquals(await toolNames(), [
        "genera_command",
        "genera_connect",
        "genera_disconnect",
        "genera_eval",
        "genera_key",
        "genera_log",
        "genera_screen",
        "genera_state",
        "genera_type",
        "genera_wait",
      ]);

      const evalRes = await client.callTool({
        name: "genera_eval",
        arguments: { form: "(* 6 7)" },
      });
      assertEquals(text(evalRes), "=> 42");
      assert(!(evalRes as { isError?: boolean }).isError);

      const errRes = await client.callTool({
        name: "genera_eval",
        arguments: { form: "(car 5)" },
      });
      assert((errRes as { isError?: boolean }).isError, "error not flagged");
      assertStringIncludes(text(errRes), "error: The first argument");

      const cmdRes = await client.callTool({
        name: "genera_command",
        arguments: { text: "Show Herald" },
      });
      assertStringIncludes(text(cmdRes), "Genera 9.0.8");

      const typeRes = await client.callTool({
        name: "genera_type",
        arguments: { text: "(+ 1 2)" },
      });
      assertStringIncludes(text(typeRes), "3");

      const keyRes = await client.callTool({
        name: "genera_key",
        arguments: { name: "c-m-Abort", mode: "none" },
      });
      assert(!(keyRes as { isError?: boolean }).isError);
      assertEquals(login.sessions[0].input.at(-1), {
        bits: 3,
        code: KEY_CODES.Abort,
      });

      const state = JSON.parse(
        text(await client.callTool({ name: "genera_state", arguments: {} })),
      );
      assertEquals(state.connected, true);
      assertEquals(state.loginPort, login.port);
      assertEquals(state.rshPort, rsh.port);

      // A second read of an idle screen must not repeat the grid.
      await client.callTool({ name: "genera_screen", arguments: {} });
      const againRes = await client.callTool({
        name: "genera_screen",
        arguments: {},
      });
      assertEquals(text(againRes), "(screen unchanged)");

      const byeRes = await client.callTool({
        name: "genera_disconnect",
        arguments: {},
      });
      assertEquals(text(byeRes), "logged out");
      assert(await waitFor(() => login.sessions[0].loggedOut), "no logout");

      // Logged out: back to the offline set.
      assertEquals(await toolNames(), OFFLINE);
    } finally {
      await client.close();
      login.close();
      rsh.close();
    }
  },
});
