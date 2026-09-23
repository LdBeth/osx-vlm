#!/usr/bin/env -S deno run --allow-net
/**
 * supdup — an interactive SUPDUP (RFC 734) terminal client for Genera.
 *
 * Like `telnet`, but speaking SUPDUP to Genera's remote-login server
 * (TCP 95), so the Lisp Machine gets a real display terminal with cursor
 * addressing, insert/delete line/char, and the full Lisp Machine keyboard
 * (Control/Meta/Super/Hyper bits and the Top keys Help, Abort, End, ...).
 *
 * Three layers, bottom up:
 *
 *   1. Option block  — the 36-bit TTYOPT/HEIGHT/WIDTH words sent on connect,
 *                      packed as six 6-bit bytes per word.
 *   2. Output decoder — ITS %TD display codes -> ANSI/xterm escapes, with its
 *                      state kept across TCP chunk boundaries.
 *   3. Key encoder   — local tty bytes (xterm CSI/SS3, Option-as-Meta ESC
 *                      prefix, the Ctrl-] escape menu) -> SUPDUP input bytes.
 *
 * All three are pure and exported for tests; `runSession` wires them to
 * injected streams, and `main` wires those to the socket and the raw tty.
 *
 * Server side reference (read-only): sys.sct/network/network-terminal.lisp
 * (SUPDUP-TERMINAL) and remote-terminal.lisp in the rel-9-0 tree.
 *
 *   ./supdup.ts [host] [port]        default 192.168.2.2 95
 */

// ---------------------------------------------------------------------------
// Protocol constants (octal, as in network-terminal.lisp)
// ---------------------------------------------------------------------------

export const DEFAULT_HOST = "192.168.2.2";
export const DEFAULT_PORT = 95;

/** ITS output buffer (%TD) codes. */
export const TD = {
  MOV: 0o200, // oldv oldh newv newh
  EOF: 0o202, // clear to end of screen
  EOL: 0o203, // clear to end of line
  DLF: 0o204, // erase char at cursor, don't move
  CRL: 0o207, // newline + clear new line
  NOP: 0o210,
  BS: 0o211,
  LF: 0o212,
  RCR: 0o213,
  QOT: 0o215, // quote next byte
  FS: 0o216, // cursor forward
  MV0: 0o217, // v h
  CLR: 0o220,
  BEL: 0o221,
  ILP: 0o223, // n
  DLP: 0o224, // n
  ICP: 0o225, // n
  DCP: 0o226, // n
  RSU: 0o232, // height n (not advertised)
  RSD: 0o233, // height n (not advertised)
} as const;

/** TTYOPT left-half bits (the word value is bit << 18). */
export const TO = {
  ERS: 0o400000, // can erase
  MVB: 0o010000, // can move back
  SAI: 0o004000, // SAIL character set   (NOT set)
  OVR: 0o001000, // overstrike           (NOT set)
  MVU: 0o000400, // video: can move up
  FCI: 0o000010, // full 12-bit character set
  LID: 0o000002, // insert/delete line
  CID: 0o000001, // insert/delete char
} as const;

/** TTYOPT right-half bits. */
export const TP = {
  CBS: 0o40, // ^\ intelligent-terminal escapes
  RSC: 0o4, // region scroll (NOT set)
} as const;

export const TTYOPT_LEFT = TO.ERS | TO.MVB | TO.MVU | TO.FCI | TO.LID | TO.CID;
export const TTYOPT_RIGHT = TP.CBS;

/** SUPDUP input escapes. */
export const ITP_ESCAPE = 0o34; // ^\ : bucky-bit prefix
export const SUPDUP_ESCAPE = 0o300; // followed by 0301 = logout
export const LOGOUT = [0o300, 0o301];

/** Modifier bits carried in the byte after ^\ (added to 0100). */
export const BIT = {
  CONTROL: 1,
  META: 2,
  SUPER: 4,
  HYPER: 8,
  TOP: 16,
} as const;

const ESC = "\x1b";
export const ANSI_AUTOWRAP_OFF = `${ESC}[?7l`;
export const ANSI_AUTOWRAP_ON = `${ESC}[?7h`;

// ---------------------------------------------------------------------------
// 1. Option block
// ---------------------------------------------------------------------------

/** A 36-bit word as two 18-bit halves (JS numbers can't do 36-bit bitops). */
export type Word = [left: number, right: number];

export interface TermOptions {
  rows: number;
  cols: number;
  ttyoptLeft?: number;
  ttyoptRight?: number;
  speed?: number;
}

/** Push an 18-bit half as three 6-bit bytes, high-order first. */
function pushHalf(out: number[], h: number): void {
  out.push((h >> 12) & 0o77, (h >> 6) & 0o77, h & 0o77);
}

/** Encode words as the SUPDUP option block: header (-count,,0) + words. */
export function encodeWords(words: Word[]): Uint8Array {
  const out: number[] = [];
  pushHalf(out, (1 << 18) - words.length);
  pushHalf(out, 0);
  for (const [l, r] of words) {
    pushHalf(out, l & 0o777777);
    pushHalf(out, r & 0o777777);
  }
  return new Uint8Array(out);
}

/** The words we send: TCTYP TTYOPT HEIGHT WIDTH TTYROL SMARTS ISPEED OSPEED. */
export function optionWords(o: TermOptions): Word[] {
  const speed = o.speed ?? 9600;
  return [
    [0, 7], // TCTYP (%TNSFW; Genera ignores it)
    [o.ttyoptLeft ?? TTYOPT_LEFT, o.ttyoptRight ?? TTYOPT_RIGHT],
    [0, o.rows],
    [0, o.cols],
    [0, 1], // TTYROL
    [0, 0], // SMARTS
    [0, speed],
    [0, speed],
  ];
}

export function encodeOptionBlock(o: TermOptions): Uint8Array {
  return encodeWords(optionWords(o));
}

/**
 * Parse an option block the way Genera's READ-SUPDUP-OPTIONS does.  Returns
 * null if `bytes` does not yet hold a complete block; otherwise the words
 * and how many bytes were consumed.  (Used by the test's fake server.)
 */
export function decodeOptionBlock(
  bytes: Uint8Array,
): { words: Word[]; length: number } | null {
  if (bytes.length < 6) return null;
  const half = (i: number) =>
    ((bytes[i] & 0o77) << 12) | ((bytes[i + 1] & 0o77) << 6) |
    (bytes[i + 2] & 0o77);
  const count = (1 << 18) - half(0);
  const length = 6 + 6 * count;
  if (bytes.length < length) return null;
  const words: Word[] = [];
  for (let i = 0; i < count; i++) {
    words.push([half(6 + 6 * i), half(9 + 6 * i)]);
  }
  return { words, length };
}

// ---------------------------------------------------------------------------
// 2. Output decoder: %TD codes -> ANSI
// ---------------------------------------------------------------------------

/** Number of argument bytes each %TD code takes. */
const TD_ARGS: Record<number, number> = {
  [TD.MOV]: 4,
  [TD.MV0]: 2,
  [TD.ILP]: 1,
  [TD.DLP]: 1,
  [TD.ICP]: 1,
  [TD.DCP]: 1,
  [TD.RSU]: 2,
  [TD.RSD]: 2,
  [TD.QOT]: 1,
};

/** Control bytes passed through to the local terminal: BEL BS TAB LF CR. */
const PASS_CONTROLS = new Set([0o7, 0o10, 0o11, 0o12, 0o15]);

function csi(n: number, final: string): string {
  return n > 0 ? `${ESC}[${n}${final}` : "";
}

/**
 * Stateful %TD decoder.  `feed` takes one TCP chunk and returns the ANSI text
 * for it; a code whose arguments straddle chunks completes on a later feed.
 */
export class SupdupDecoder {
  #op = -1; // pending %TD code awaiting arguments, or -1
  #args: number[] = [];

  feed(chunk: Uint8Array): string {
    let out = "";
    for (const b of chunk) {
      if (this.#op >= 0) {
        this.#args.push(b);
        if (this.#args.length === TD_ARGS[this.#op]) {
          out += this.#finish(this.#op, this.#args);
          this.#op = -1;
          this.#args = [];
        }
        continue;
      }
      if (b >= 0o40 && b < 0o177) out += String.fromCharCode(b);
      else if (b < 0o40) {
        if (PASS_CONTROLS.has(b)) out += String.fromCharCode(b);
      } else if (b in TD_ARGS) {
        this.#op = b;
      } else {
        out += this.#simple(b);
      }
    }
    return out;
  }

  /** Zero-argument codes; unknown bytes >= 0200 (and DEL) vanish. */
  #simple(b: number): string {
    switch (b) {
      case TD.EOF:
        return `${ESC}[J`;
      case TD.EOL:
        return `${ESC}[K`;
      case TD.DLF:
        return `${ESC}[X`;
      case TD.CRL:
        return `\r\n${ESC}[K`;
      case TD.BS:
        return "\b";
      case TD.LF:
        return `${ESC}[B`;
      case TD.RCR:
        return "\r";
      case TD.FS:
        return `${ESC}[C`;
      case TD.CLR:
        return `${ESC}[H${ESC}[2J`;
      case TD.BEL:
        return "\x07";
      default: // %TDNOP and anything unknown
        return "";
    }
  }

  #finish(op: number, a: number[]): string {
    switch (op) {
      case TD.MV0:
        return `${ESC}[${a[0] + 1};${a[1] + 1}H`;
      case TD.MOV:
        return `${ESC}[${a[2] + 1};${a[3] + 1}H`;
      case TD.ILP:
        return csi(a[0], "L");
      case TD.DLP:
        return csi(a[0], "M");
      case TD.ICP:
        return csi(a[0], "@");
      case TD.DCP:
        return csi(a[0], "P");
      case TD.QOT: {
        // Quoted byte: output it if the local terminal can show it as-is.
        const q = a[0];
        return (q >= 0o40 && q < 0o177) || PASS_CONTROLS.has(q)
          ? String.fromCharCode(q)
          : "";
      }
      default: // %TDRSU / %TDRSD: region scroll is not advertised; ignore.
        return "";
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Key encoder: local tty bytes -> SUPDUP input
// ---------------------------------------------------------------------------

const ESCAPE_KEY = 0o35; // Ctrl-]: local escape, like telnet's

/** ^\ (0100+bits) char. */
export function bucky(bits: number, ch: string | number): number[] {
  const c = typeof ch === "string" ? ch.charCodeAt(0) : ch;
  return [ITP_ESCAPE, 0o100 + bits, c];
}
const ctl = (ch: string) => bucky(BIT.CONTROL, ch);
const meta = (ch: string) => bucky(BIT.META, ch);
const top = (ch: string) => bucky(BIT.TOP, ch);

/** Named Lisp Machine keys and the bytes that produce them. */
export const KEYS = {
  help: top("H"),
  suspend: top("B"),
  clearInput: top("C"),
  function: top("A"),
  abort: top("a"),
  end: top("e"),
  network: top("n"),
  square: top("1"),
  circle: top("2"),
  triangle: top("3"),
  resume: ctl("H"), // SUPDUP-KLUDGE-FILTER turns c-H into Resume
  refresh: [0o14],
  cRightBracket: ctl("]"),
} as const;

/** CSI/SS3 final byte (no numeric parameter) -> key bytes. */
const CSI_FINAL: Record<string, readonly number[]> = {
  A: ctl("P"), // up
  B: ctl("N"), // down
  C: ctl("F"), // right
  D: ctl("B"), // left
  H: meta("<"), // Home
  F: KEYS.end, // End
  P: KEYS.help, // F1 (SS3 P / CSI 1;mP)
  Q: KEYS.suspend, // F2
  R: KEYS.resume, // F3
  S: KEYS.abort, // F4
};

/** CSI n ~ -> key bytes. */
const CSI_TILDE: Record<number, readonly number[]> = {
  1: meta("<"), // Home
  7: meta("<"),
  4: KEYS.end, // End
  8: KEYS.end,
  5: meta("V"), // PgUp
  6: ctl("V"), // PgDn
  11: KEYS.help, // F1
  12: KEYS.suspend, // F2
  13: KEYS.resume, // F3
  14: KEYS.abort, // F4
  15: KEYS.refresh, // F5
  17: KEYS.clearInput, // F6
  18: KEYS.function, // F7
  19: KEYS.end, // F8
  20: KEYS.network, // F9
};

/** Ctrl-] menu: next key -> bytes to send. */
const MENU: Record<string, readonly number[]> = {
  h: KEYS.help,
  a: KEYS.abort,
  e: KEYS.end,
  s: KEYS.suspend,
  r: KEYS.resume,
  c: KEYS.clearInput,
  f: KEYS.function,
  n: KEYS.network,
  l: KEYS.refresh,
  [String.fromCharCode(ESCAPE_KEY)]: KEYS.cRightBracket,
};

export const MENU_HELP = [
  "supdup escape (Ctrl-]) commands:",
  "  q       quit (log out and close)",
  "  h       Help           a  Abort",
  "  e       End            s  Suspend",
  "  r       Resume         c  Clear-Input",
  "  f       Function       n  Network",
  "  l       Refresh        ?  this list",
  "  Ctrl-]  send c-]",
  "Other keys: arrows = c-P/c-N/c-F/c-B, Home = m-<, End = End,",
  "PgUp/PgDn = m-V/c-V, F1 Help, F2 Suspend, F3 Resume, F4 Abort,",
  "F5 Refresh, F6 Clear-Input, F7 Function, F8 End, F9 Network;",
  "Option/Esc-prefix = Meta.",
].join("\r\n");

export interface KeyResult {
  /** Bytes to send to Genera. */
  bytes: Uint8Array;
  /** The user asked to quit (logout bytes are already in `bytes`). */
  quit: boolean;
  /** The user asked for the local escape-menu help. */
  help: boolean;
}

const isUpper = (c: number) => c >= 0o101 && c <= 0o132;
const isLower = (c: number) => c >= 0o141 && c <= 0o172;
const isLetter = (c: number) => isUpper(c) || isLower(c);

/**
 * Encode one printable/control byte with the given extra bucky bits
 * (0 or META).  Returns the SUPDUP bytes.
 */
function encodeByte(b: number, extra: number): number[] {
  if (b >= 0o200) return []; // UTF-8 etc.: 0300 would be a SUPDUP escape
  // Raw specials: Tab, Return, Backspace, Escape, Rubout.
  const raw = b === 0o11 || b === 0o15 || b === 0o10 || b === 0o33 ||
    b === 0o177;
  if (raw) return extra ? bucky(extra, b) : [b];
  if (b === ITP_ESCAPE) {
    return extra ? bucky(BIT.CONTROL | extra, "\\") : [ITP_ESCAPE, ITP_ESCAPE];
  }
  if (b < 0o40) {
    // Ctrl-letter (and Ctrl-@ [ ^ _ ]): control bit + the uppercase char.
    return bucky(BIT.CONTROL | extra, b + 0o100);
  }
  if (!extra) return [b];
  // Genera flips a letter's case when bucky bits are set: send the
  // opposite case so the unshifted key arrives as the unshifted key.
  return bucky(extra, isLetter(b) ? b ^ 0o40 : b);
}

/**
 * Stateful key encoder.  The only state carried between reads is "Ctrl-]
 * was the last key"; ESC-as-Meta and CSI parsing work within one read, as
 * a terminal delivers a whole key sequence in one write.
 */
export class KeyEncoder {
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
      if (b !== 0o33) {
        out.push(...encodeByte(b, 0));
        i++;
        continue;
      }
      // ESC: lone, CSI/SS3, or Meta prefix.
      if (i + 1 >= chunk.length) {
        out.push(0o33);
        i++;
        continue;
      }
      const n = chunk[i + 1];
      if ((n === 0o133 || n === 0o117) && i + 2 < chunk.length) {
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
      if (n === ESCAPE_KEY) {
        out.push(...bucky(BIT.CONTROL | BIT.META, "]"));
      } else {
        out.push(...encodeByte(n, BIT.META));
      }
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
  return new KeyEncoder().feed(bytes);
}

// ---------------------------------------------------------------------------
// Session: wire the codecs to injected streams
// ---------------------------------------------------------------------------

export interface SessionIO {
  /** The TCP connection (or a fake). */
  net: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  /** Local keyboard bytes (the raw tty), or null for none. */
  keys: ReadableStream<Uint8Array> | null;
  /** Receives the rendered ANSI text. */
  write: (s: string) => void | Promise<void>;
  /** Local notices (the escape-menu help); written to stderr by main. */
  note: (s: string) => void;
  rows: number;
  cols: number;
}

/**
 * Run one SUPDUP session: send the option block, then pump both directions
 * until the server closes or the user quits.  Resolves with how it ended.
 */
export async function runSession(io: SessionIO): Promise<"closed" | "quit"> {
  const writer = io.net.writable.getWriter();
  await writer.write(encodeOptionBlock({ rows: io.rows, cols: io.cols }));

  let done = false;
  let keyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const netReader = io.net.readable.getReader();

  const fromNet = (async () => {
    const dec = new SupdupDecoder();
    try {
      while (true) {
        const { value, done: eof } = await netReader.read();
        if (eof || !value) break;
        const s = dec.feed(value);
        if (s) await io.write(s);
      }
    } catch (e) {
      if (!done) throw e;
    }
    return "closed" as const;
  })();

  const fromKeys = (async () => {
    if (!io.keys) return new Promise<never>(() => {});
    keyReader = io.keys.getReader();
    const enc = new KeyEncoder();
    while (true) {
      const { value, done: eof } = await keyReader.read();
      if (eof || !value) return new Promise<never>(() => {}); // keep net open
      const r = enc.feed(value);
      if (r.bytes.length) await writer.write(r.bytes);
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
  try {
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const stderr = (s: string) => Deno.stderr.writeSync(encoder.encode(s));

async function main(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("usage: supdup.ts [host] [port]   (default 192.168.2.2 95)");
    return 0;
  }
  const host = args[0] ?? DEFAULT_HOST;
  const port = args[1] ? parseInt(args[1], 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    stderr(`supdup: bad port ${args[1]}\n`);
    return 2;
  }

  let rows = 24, cols = 80;
  try {
    ({ rows, columns: cols } = Deno.consoleSize());
  } catch { /* not a tty: keep 80x24 */ }

  let conn: Deno.TcpConn;
  try {
    conn = await Deno.connect({ hostname: host, port });
  } catch (e) {
    if (e instanceof Deno.errors.ConnectionRefused) {
      stderr(
        `supdup: connection to ${host} port ${port} refused.\n` +
          `The Genera login server must be enabled on the Genera side: ` +
          `remote login must be on, and this host must be trusted ` +
          `(Secure Subnets).\n`,
      );
    } else {
      stderr(`supdup: ${host} port ${port}: ${(e as Error).message}\n`);
    }
    return 1;
  }
  stderr(`Connected to ${host}. Escape character is '^]' (^] ? for help).\r\n`);

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

  const onWinch = () =>
    stderr(
      "\r\n[supdup: window resized; Genera's SUPDUP server has no resize " +
        "message, so it keeps the size from login.]\r\n",
    );
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
    const how = await runSession({
      net: conn,
      keys: Deno.stdin.readable,
      write: (s) => {
        Deno.stdout.writeSync(encoder.encode(s));
      },
      note: stderr,
      rows,
      cols,
    });
    restore();
    stderr(how === "quit" ? "\nLogged out.\n" : "\nConnection closed.\n");
  } catch (e) {
    restore();
    stderr(`\nsupdup: ${(e as Error).message}\n`);
    code = 1;
  } finally {
    restore();
    try {
      conn.close();
    } catch { /* ignore */ }
  }
  return code;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
