#!/usr/bin/env -S deno run --allow-net
/**
 * genera-remote-test — a fake Genera telnet server.
 *
 * Stands in for the VLM so `genera-remote.ts` can be tested without booting
 * Genera (which needs sudo).  It speaks the same negotiation the real server
 * does, paints a herald with X3.64 sequences, echoes typed characters, and
 * answers a small canned set of forms.
 *
 * Run standalone to poke at it by hand:
 *
 *     ./genera-remote-test.ts --port 2323
 */

import {
  AYT,
  DO,
  DONT,
  IAC,
  OPT_ECHO,
  OPT_NAWS,
  OPT_SGA,
  OPT_TTYPE,
  SB,
  SE,
  WILL,
  WONT,
} from "./genera-remote.ts";

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

/** The prompt the fake Listener paints.  Matches Genera's CP prompt. */
export const FAKE_PROMPT = "Command: ";

export interface FakeServerOptions {
  port?: number;
  hostname?: string;
  /** Canned answers, keyed by the exact form text typed. */
  responses?: Record<string, string>;
  /** Skip the herald (useful for negotiation-only tests). */
  noHerald?: boolean;
  /** Refuse NAWS, to exercise the fallback path. */
  refuseNaws?: boolean;
}

export interface FakeSession {
  /** Every application byte the client sent (negotiation stripped). */
  input: number[];
  /** Negotiation events, as "RECV WILL TTYPE" style strings. */
  negotiation: string[];
  terminalType: string | null;
  naws: { cols: number; rows: number } | null;
  closed: boolean;
}

const DEFAULT_RESPONSES: Record<string, string> = {
  "(+ 1 2)": "3",
  "(* 6 7)": "42",
  "(machine-type)": '"Symbolics Virtual Lisp Machine"',
  "(lisp-implementation-version)": '"Genera 8.5"',
};

export class FakeGeneraServer {
  #listener: Deno.Listener | null = null;
  #opts: FakeServerOptions;
  #abort = new AbortController();
  readonly sessions: FakeSession[] = [];

  constructor(opts: FakeServerOptions = {}) {
    this.#opts = opts;
  }

  get port(): number {
    const a = this.#listener!.addr as Deno.NetAddr;
    return a.port;
  }
  get hostname(): string {
    const a = this.#listener!.addr as Deno.NetAddr;
    return a.hostname;
  }

  listen(): void {
    this.#listener = Deno.listen({
      hostname: this.#opts.hostname ?? "127.0.0.1",
      port: this.#opts.port ?? 0,
    });
    this.#acceptLoop();
  }

  async #acceptLoop(): Promise<void> {
    const l = this.#listener!;
    try {
      for await (const conn of l) {
        this.#serve(conn);
      }
    } catch (_e) {
      // Listener closed.
    }
  }

  close(): void {
    this.#abort.abort();
    try {
      this.#listener?.close();
    } catch (_e) { /* already closed */ }
    this.#listener = null;
  }

  async #serve(conn: Deno.Conn): Promise<void> {
    const session: FakeSession = {
      input: [],
      negotiation: [],
      terminalType: null,
      naws: null,
      closed: false,
    };
    this.sessions.push(session);

    const enc = new TextEncoder();
    const writeRaw = async (bytes: Uint8Array) => {
      let off = 0;
      while (off < bytes.length) off += await conn.write(bytes.subarray(off));
    };
    const writeText = (s: string) => writeRaw(enc.encode(s));

    // Opening bid, exactly as a character-at-a-time server does it.
    await writeRaw(
      new Uint8Array([
        IAC,
        DO,
        OPT_TTYPE,
        ...(this.#opts.refuseNaws ? [] : [IAC, DO, OPT_NAWS]),
        IAC,
        WILL,
        OPT_ECHO,
        IAC,
        WILL,
        OPT_SGA,
        IAC,
        DO,
        OPT_SGA,
      ]),
    );

    let heraldSent = false;
    const sendHerald = async () => {
      if (heraldSent || this.#opts.noHerald) return;
      heraldSent = true;
      // Clear screen, home, herald, prompt — the shape Genera paints.
      await writeText(
        "\x1b[2J\x1b[H" +
          "Symbolics Virtual Lisp Machine\r\n" +
          "Genera 8.5\r\n" +
          "\r\n" +
          FAKE_PROMPT,
      );
    };

    let lineBuf = "";
    const responses = { ...DEFAULT_RESPONSES, ...(this.#opts.responses ?? {}) };

    const handleData = async (b: number) => {
      session.input.push(b);
      if (b === 0x0d) { // Return
        const form = lineBuf.trim();
        lineBuf = "";
        await writeText("\r\n");
        if (form.length) {
          const answer = responses[form];
          if (answer !== undefined) await writeText(answer + "\r\n");
          else await writeText(`Unbound: ${form}\r\n`);
        }
        await writeText(FAKE_PROMPT);
      } else if (b === 0x0a) {
        // LF alone: the real server treats a bare LF as end-of-line too.
      } else if (b === 0x7f || b === 0x08) { // Rubout
        if (lineBuf.length) {
          lineBuf = lineBuf.slice(0, -1);
          await writeText("\b \b"); // server-side echo of the erase
        }
      } else if (b >= 0x20 && b < 0x7f) {
        lineBuf += String.fromCharCode(b);
        await writeText(String.fromCharCode(b)); // server echoes
      } else {
        // Control character: echo Genera-style so tests can see it landed.
        await writeText(`^${String.fromCharCode(b + 0x40)}`);
      }
    };

    // -- IAC parser (server side) -------------------------------------------
    let state:
      | "data"
      | "iac"
      | "will"
      | "wont"
      | "do"
      | "dont"
      | "sb"
      | "sb-iac" = "data";
    let sbOpt = -1;
    let sbBuf: number[] = [];

    const optName = (o: number) =>
      ({ 0: "BINARY", 1: "ECHO", 3: "SGA", 24: "TTYPE", 31: "NAWS" } as Record<
        number,
        string
      >)[o] ?? `OPT-${o}`;

    const buf = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        for (const b of buf.subarray(0, n)) {
          switch (state) {
            case "data":
              if (b === IAC) state = "iac";
              else await handleData(b);
              break;
            case "iac":
              if (b === IAC) {
                await handleData(IAC);
                state = "data";
              } else if (b === WILL) state = "will";
              else if (b === WONT) state = "wont";
              else if (b === DO) state = "do";
              else if (b === DONT) state = "dont";
              else if (b === SB) {
                state = "sb";
                sbOpt = -1;
                sbBuf = [];
              } else {
                session.negotiation.push(`RECV CMD-${b}`);
                if (b === AYT) await writeText("\r\n[fake genera alive]\r\n");
                state = "data";
              }
              break;
            case "will":
              session.negotiation.push(`RECV WILL ${optName(b)}`);
              if (b === OPT_TTYPE) {
                await writeRaw(
                  new Uint8Array([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]),
                );
              } else if (b === OPT_NAWS && this.#opts.refuseNaws) {
                await writeRaw(new Uint8Array([IAC, DONT, OPT_NAWS]));
              } else if (b !== OPT_SGA && b !== OPT_NAWS) {
                await writeRaw(new Uint8Array([IAC, DONT, b]));
              }
              state = "data";
              break;
            case "wont":
              session.negotiation.push(`RECV WONT ${optName(b)}`);
              state = "data";
              break;
            case "do":
              session.negotiation.push(`RECV DO ${optName(b)}`);
              if (b !== OPT_ECHO && b !== OPT_SGA) {
                await writeRaw(new Uint8Array([IAC, WONT, b]));
              }
              state = "data";
              break;
            case "dont":
              session.negotiation.push(`RECV DONT ${optName(b)}`);
              state = "data";
              break;
            case "sb":
              if (b === IAC) state = "sb-iac";
              else if (sbOpt < 0) sbOpt = b;
              else sbBuf.push(b);
              break;
            case "sb-iac":
              if (b === IAC) {
                sbBuf.push(IAC);
                state = "sb";
              } else if (b === SE) {
                if (sbOpt === OPT_TTYPE && sbBuf[0] === TTYPE_IS) {
                  session.terminalType = new TextDecoder().decode(
                    new Uint8Array(sbBuf.slice(1)),
                  );
                  session.negotiation.push(
                    `RECV SB TTYPE IS ${session.terminalType}`,
                  );
                  await sendHerald();
                } else if (sbOpt === OPT_NAWS && sbBuf.length >= 4) {
                  session.naws = {
                    cols: (sbBuf[0] << 8) | sbBuf[1],
                    rows: (sbBuf[2] << 8) | sbBuf[3],
                  };
                  session.negotiation.push(
                    `RECV SB NAWS ${session.naws.cols}x${session.naws.rows}`,
                  );
                }
                state = "data";
              } else {
                state = "data";
              }
              break;
          }
        }
      }
    } catch (_e) {
      // Client vanished.
    }
    session.closed = true;
    try {
      conn.close();
    } catch (_e) { /* already closed */ }
  }
}

// -- standalone ------------------------------------------------------------

if (import.meta.main) {
  const args = Deno.args;
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : 2323;
  const server = new FakeGeneraServer({ port });
  server.listen();
  console.error(`fake genera listening on 127.0.0.1:${server.port}`);
  await new Promise(() => {}); // run until killed
}
