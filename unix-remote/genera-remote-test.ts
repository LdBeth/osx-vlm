#!/usr/bin/env -S deno run --allow-net
/**
 * genera-remote-test — fake Genera servers for testing genera-remote.ts
 * without booting the VLM (which needs sudo):
 *
 *   FakeLoginServer  3600-LOGIN (TCP 57): records the size message, decodes
 *                    `3, bits, code` input, paints a herald with 3600 ops,
 *                    echoes, and answers canned forms with a `Command: `
 *                    prompt, completing a form on its closing paren the way
 *                    Genera's Listener does.
 *   FakeRshServer    rsh (TCP 514): parses the four C-strings and replies
 *                    through a handler callback.
 *
 * Run standalone to poke at them by hand:
 *
 *     ./genera-remote-test.ts --login-port 5757 --rsh-port 5514
 */

import { KEY_CODES, OP } from "./genera-3600.ts";

/** The prompt the fake Listener paints.  Matches Genera's CP prompt. */
export const FAKE_PROMPT = "Command: ";

export const FAKE_HERALD = [
  "Symbolics System, FAKE:>initial.vlod",
  "Fake Virtual Lisp Machine",
  " Genera  9.0.8",
];

/** Canned answers, keyed by the exact form text typed. */
export const DEFAULT_RESPONSES: Record<string, string> = {
  "(+ 1 2)": "3",
  "(* 6 7)": "42",
  "(machine-type)": '"Symbolics Virtual Lisp Machine"',
};

export interface LoginInput {
  bits: number;
  code: number;
}

export interface FakeLoginSession {
  /** Every size message, in order (the first is the login size). */
  sizes: Array<{ cols: number; rows: number }>;
  /** Every `3, bits, code` character, in order. */
  input: LoginInput[];
  /** The location string, if the client sent one. */
  location: string | null;
  loggedOut: boolean;
  /** A bad lead byte, as the real server would FERROR on. */
  protocolError: string | null;
  closed: boolean;
}

export interface FakeLoginOptions {
  hostname?: string;
  port?: number;
  responses?: Record<string, string>;
  /** Delay before the herald, like Genera's ~2 s init window (default 50). */
  heraldDelayMs?: number;
}

const enc = new TextEncoder();

export class FakeLoginServer {
  #listener: Deno.Listener | null = null;
  #opts: FakeLoginOptions;
  readonly sessions: FakeLoginSession[] = [];

  constructor(opts: FakeLoginOptions = {}) {
    this.#opts = opts;
  }

  get port(): number {
    return (this.#listener!.addr as Deno.NetAddr).port;
  }
  get hostname(): string {
    return (this.#listener!.addr as Deno.NetAddr).hostname;
  }

  listen(): void {
    this.#listener = Deno.listen({
      hostname: this.#opts.hostname ?? "127.0.0.1",
      port: this.#opts.port ?? 0,
    });
    (async () => {
      try {
        for await (const conn of this.#listener!) this.#serve(conn);
      } catch { /* listener closed */ }
    })();
  }

  close(): void {
    try {
      this.#listener?.close();
    } catch { /* already closed */ }
    this.#listener = null;
  }

  async #serve(conn: Deno.Conn): Promise<void> {
    const s: FakeLoginSession = {
      sizes: [],
      input: [],
      location: null,
      loggedOut: false,
      protocolError: null,
      closed: false,
    };
    this.sessions.push(s);
    const responses = { ...DEFAULT_RESPONSES, ...(this.#opts.responses ?? {}) };

    let col = 0, row = 0;
    const out: number[] = [];
    const text = (t: string) => {
      for (const b of enc.encode(t)) out.push(b);
      col += t.length;
    };
    const newline = () => {
      out.push(OP.NEWLINE);
      col = 0;
      row++;
    };
    const flush = async () => {
      const data = Uint8Array.from(out.splice(0));
      let off = 0;
      try {
        while (off < data.length) off += await conn.write(data.subarray(off));
      } catch { /* client gone */ }
    };

    let heraldSent = false;
    const herald = async () => {
      if (heraldSent) return;
      heraldSent = true;
      out.push(OP.CLEAR);
      col = row = 0;
      for (const l of FAKE_HERALD) {
        text(l);
        newline();
      }
      newline();
      text(FAKE_PROMPT);
      await flush();
    };

    let line = "";
    const answer = async (form: string) => {
      newline();
      text(responses[form] ?? `Unbound: ${form}`);
      newline();
      text(FAKE_PROMPT);
      await flush();
    };
    const onChar = async ({ bits, code }: LoginInput) => {
      s.input.push({ bits, code });
      if (bits) return; // bucky keys: recorded only
      if (code === KEY_CODES.Return) {
        const form = line.trim();
        line = "";
        if (form) await answer(form);
        else {
          newline();
          text(FAKE_PROMPT);
          await flush();
        }
      } else if (code === KEY_CODES.Rubout) {
        if (!line.length) return;
        line = line.slice(0, -1);
        col--;
        out.push(OP.SET_CURSOR, col, row, OP.CLEAR_EOL);
        await flush();
      } else if (code >= 0x20 && code < 0x7f) {
        line += String.fromCharCode(code);
        text(String.fromCharCode(code));
        await flush();
        // The Listener activates when a closing paren completes the form.
        if (code === 0x29 && balanced(line)) {
          const form = line.trim();
          line = "";
          await answer(form);
        }
      }
    };

    // Genera waits out its init window before painting.
    const heraldTimer = setTimeout(
      () => herald(),
      this.#opts.heraldDelayMs ?? 50,
    );

    const pending: number[] = [];
    const buf = new Uint8Array(4096);
    try {
      loop: while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        pending.push(...buf.subarray(0, n));
        while (pending.length) {
          const lead = pending[0];
          if (lead === 0) {
            s.loggedOut = true;
            break loop;
          } else if (lead === 1) {
            if (pending.length < 3) break;
            const [, cols, rows] = pending.splice(0, 3);
            s.sizes.push({ cols, rows });
          } else if (lead === 2) {
            if (pending.length < 2 || pending.length < 2 + pending[1]) break;
            const len = pending[1];
            s.location = String.fromCharCode(
              ...pending.splice(0, 2 + len).slice(2),
            );
          } else if (lead === 3) {
            if (pending.length < 3) break;
            const [, bits, code] = pending.splice(0, 3);
            await onChar({ bits, code });
          } else {
            s.protocolError = `bad lead byte ${lead}`;
            break loop;
          }
        }
      }
    } catch { /* client vanished */ }
    clearTimeout(heraldTimer);
    s.closed = true;
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") d--;
  }
  return d === 0;
}

// ---------------------------------------------------------------------------
// Fake rsh
// ---------------------------------------------------------------------------

/**
 * Reply to one rsh command: the raw reply text (lead byte included, one
 * char per byte), or null to hang until the client gives up.
 */
export type RshHandler = (command: string, fields: string[]) => string | null;

/**
 * A small evaluator for the wrapped forms genera-rsh sends, and a couple of
 * CP commands.  Unknown forms return no values.
 */
export const defaultRshHandler: RshHandler = (cmd) => {
  const m = /multiple-value-list (.*)\)\)\) \(cl:format cl:t "(RSH[0-9a-f]+)V/
    .exec(cmd);
  if (!m) {
    if (cmd === "Show Herald") return "\0\nGenera 9.0.8\nFake Machine\n";
    if (cmd === "busy") return "\x01This machine is in use by LDBETH\n";
    return `\0Unknown command: ${cmd}\n`;
  }
  const [, form, n] = m;
  const canned = DEFAULT_RESPONSES[form];
  if (canned !== undefined) return `\0${n}V${canned}${n}\n`;
  if (form === "(progn (print 1) (values 2 3))") {
    return `\0\n1 ${n}V2${n}3${n}\n`;
  }
  if (form === "(car 5)") {
    return `\0${n}EThe first argument to the CAR instruction, 5, was not a list\n`;
  }
  if (form === "(loop)") return null;
  return `\0${n}V${n}\n`;
};

export class FakeRshServer {
  #listener: Deno.Listener | null = null;
  #handler: RshHandler;
  #hanging = new Set<Deno.Conn>();
  /** The four fields of every request, in order. */
  readonly requests: string[][] = [];

  constructor(handler: RshHandler = defaultRshHandler) {
    this.#handler = handler;
  }

  get port(): number {
    return (this.#listener!.addr as Deno.NetAddr).port;
  }
  get hostname(): string {
    return (this.#listener!.addr as Deno.NetAddr).hostname;
  }

  listen(port = 0, hostname = "127.0.0.1"): void {
    this.#listener = Deno.listen({ hostname, port });
    (async () => {
      try {
        for await (const conn of this.#listener!) this.#serve(conn);
      } catch { /* listener closed */ }
    })();
  }

  close(): void {
    try {
      this.#listener?.close();
    } catch { /* already closed */ }
    this.#listener = null;
    for (const c of this.#hanging) {
      try {
        c.close();
      } catch { /* closed by the client */ }
    }
    this.#hanging.clear();
  }

  async #serve(conn: Deno.Conn): Promise<void> {
    const got: number[] = [];
    const buf = new Uint8Array(4096);
    let fields: string[] = [];
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        got.push(...buf.subarray(0, n));
        fields = String.fromCharCode(...got).split("\0");
        if (fields.length >= 5) break; // four terminators seen
      }
    } catch { /* client gone */ }
    fields = fields.slice(0, 4);
    this.requests.push(fields);
    const reply = this.#handler(fields[3] ?? "", fields);
    if (reply === null) {
      this.#hanging.add(conn); // closed by the client's timeout, or close()
      return;
    }
    const bytes = Uint8Array.from(reply, (c) => c.charCodeAt(0) & 0xff);
    try {
      let off = 0;
      while (off < bytes.length) off += await conn.write(bytes.subarray(off));
    } catch { /* client gone */ }
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

// -- standalone ------------------------------------------------------------

if (import.meta.main) {
  const arg = (name: string, def: number) => {
    const i = Deno.args.indexOf(name);
    return i >= 0 ? parseInt(Deno.args[i + 1], 10) : def;
  };
  const login = new FakeLoginServer({ port: arg("--login-port", 5757) });
  login.listen();
  const rsh = new FakeRshServer();
  rsh.listen(arg("--rsh-port", 5514));
  console.error(
    `fake genera: 3600-LOGIN on 127.0.0.1:${login.port}, rsh on 127.0.0.1:${rsh.port}`,
  );
  await new Promise(() => {}); // run until killed
}
