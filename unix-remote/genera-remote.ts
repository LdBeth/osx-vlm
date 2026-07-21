#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * genera-remote — drive a Genera Lisp Listener over telnet, from the host.
 *
 * Three layers, bottom up:
 *
 *   1. Telnet client   — raw TCP + the IAC negotiation Genera's server expects.
 *   2. Screen model    — an in-memory character grid fed by an X3.64/ANSI parser.
 *   3. MCP / CLI       — tools and subcommands that read the grid and type at it.
 *
 * The telnet client and the screen model are dependency-free; only the MCP
 * layer reaches for npm.  See README.md for the protocol findings this is
 * built on.
 */

// ---------------------------------------------------------------------------
// Telnet protocol constants (RFC 854 and friends)
// ---------------------------------------------------------------------------

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const GA = 249;
export const EL = 248;
export const EC = 247;
export const AYT = 246;
export const AO = 245;
export const IP = 244;
export const BRK = 243;
export const DM = 242;
export const NOP = 241;
export const SE = 240;

export const OPT_BINARY = 0;
export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_STATUS = 5;
export const OPT_TIMING_MARK = 6;
export const OPT_TTYPE = 24;
export const OPT_EOR = 25;
export const OPT_NAWS = 31;
export const OPT_TSPEED = 32;
export const OPT_LFLOW = 33;
export const OPT_LINEMODE = 34;
export const OPT_NEW_ENVIRON = 39;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

/** Option negotiation state, per RFC 1143's "Q method" (simplified). */
const NO = 0, YES = 1, WANTYES = 2, WANTNO = 3;

export const OPTION_NAMES: Record<number, string> = {
  [OPT_BINARY]: "BINARY",
  [OPT_ECHO]: "ECHO",
  [OPT_SGA]: "SGA",
  [OPT_STATUS]: "STATUS",
  [OPT_TIMING_MARK]: "TIMING-MARK",
  [OPT_TTYPE]: "TTYPE",
  [OPT_EOR]: "EOR",
  [OPT_NAWS]: "NAWS",
  [OPT_TSPEED]: "TSPEED",
  [OPT_LFLOW]: "LFLOW",
  [OPT_LINEMODE]: "LINEMODE",
  [OPT_NEW_ENVIRON]: "NEW-ENVIRON",
};

const CMD_NAMES: Record<number, string> = {
  [WILL]: "WILL",
  [WONT]: "WONT",
  [DO]: "DO",
  [DONT]: "DONT",
  [SB]: "SB",
  [SE]: "SE",
  [NOP]: "NOP",
  [DM]: "DM",
  [BRK]: "BRK",
  [IP]: "IP",
  [AO]: "AO",
  [AYT]: "AYT",
  [EC]: "EC",
  [EL]: "EL",
  [GA]: "GA",
};

export function optionName(o: number): string {
  return OPTION_NAMES[o] ?? `OPT-${o}`;
}
export function commandName(c: number): string {
  return CMD_NAMES[c] ?? `CMD-${c}`;
}

// ---------------------------------------------------------------------------
// Telnet option policy
// ---------------------------------------------------------------------------
//
// "us" = options we are willing to turn on for ourselves (we send WILL).
// "him" = options we are willing to let the server turn on (we send DO).
//
// Genera's server drives a full-duplex character-at-a-time session: it echoes
// (WILL ECHO) and suppresses go-ahead (WILL SGA / DO SGA).  We must not echo
// locally, and we must not line-buffer.

const WE_SUPPORT = new Set([OPT_TTYPE, OPT_NAWS, OPT_SGA, OPT_BINARY]);
const WE_WANT_HIM = new Set([OPT_ECHO, OPT_SGA, OPT_BINARY]);

/** Terminal types offered, in order.  See README for why x3.64 wins. */
export const DEFAULT_TERMINAL_TYPES = ["x3.64", "ansi", "vt100", "UNKNOWN"];

export interface TelnetEvents {
  onData(bytes: Uint8Array): void;
  onNegotiation?(line: string): void;
  onClose?(): void;
}

/**
 * Minimal telnet client.  Parses the IAC stream, answers negotiation, and
 * hands the application only real data bytes.
 */
export class TelnetClient {
  #conn: Deno.Conn | null = null;
  #us = new Map<number, number>();
  #him = new Map<number, number>();
  #ttypeIndex = 0;
  #events: TelnetEvents;
  #closed = false;

  /** Parser state for the incoming byte stream. */
  #state: "data" | "iac" | "will" | "wont" | "do" | "dont" | "sb" | "sb-iac" =
    "data";
  #sbOption = 0;
  #sbBuf: number[] = [];

  terminalTypes: string[];
  windowSize: { cols: number; rows: number };
  /** Transcript of negotiation, for tests and troubleshooting. */
  readonly negotiationLog: string[] = [];

  constructor(
    events: TelnetEvents,
    opts: { terminalTypes?: string[]; cols?: number; rows?: number } = {},
  ) {
    this.#events = events;
    this.terminalTypes = opts.terminalTypes ?? [...DEFAULT_TERMINAL_TYPES];
    this.windowSize = { cols: opts.cols ?? 80, rows: opts.rows ?? 24 };
  }

  get connected(): boolean {
    return this.#conn !== null && !this.#closed;
  }

  /** True once the server has told us it will echo. */
  get serverEchoes(): boolean {
    return this.#him.get(OPT_ECHO) === YES;
  }
  get binaryMode(): boolean {
    return this.#him.get(OPT_BINARY) === YES &&
      this.#us.get(OPT_BINARY) === YES;
  }
  get nawsAccepted(): boolean {
    return this.#us.get(OPT_NAWS) === YES;
  }
  /** The terminal type the server actually took (the last one we sent). */
  get negotiatedTerminalType(): string | null {
    return this.#sentTerminalType;
  }
  #sentTerminalType: string | null = null;

  async connect(hostname: string, port: number): Promise<void> {
    this.#conn = await Deno.connect({ hostname, port });
    this.#closed = false;
    // Offer what we support up front.  Genera's real telnet server negotiates
    // almost nothing: it sends only IAC WILL ECHO and silently ignores DO/
    // WILL/WONT/DONT for everything else (network/network-terminal.lisp).  So
    // against the real server these offers go unanswered and stay pending —
    // harmless.  They matter for well-behaved servers and for our test rig.
    this.#sendWill(OPT_TTYPE);
    this.#sendWill(OPT_NAWS);
    this.#sendDo(OPT_SGA);
    this.#sendWill(OPT_SGA);
    this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    const conn = this.#conn!;
    const buf = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(buf);
        if (n === null) break;
        this.feed(buf.subarray(0, n));
      }
    } catch (_e) {
      // Connection reset / closed underneath us — treated as a close.
    }
    this.#closed = true;
    this.#conn = null;
    this.#events.onClose?.();
  }

  /**
   * Push raw bytes through the IAC parser.  Exposed for tests so the protocol
   * can be exercised without a socket.
   */
  feed(bytes: Uint8Array): void {
    const data: number[] = [];
    const flush = () => {
      if (data.length) {
        this.#events.onData(new Uint8Array(data));
        data.length = 0;
      }
    };

    for (const b of bytes) {
      switch (this.#state) {
        case "data":
          if (b === IAC) this.#state = "iac";
          else data.push(b);
          break;

        case "iac":
          if (b === IAC) {
            data.push(IAC); // escaped 255
            this.#state = "data";
          } else if (b === WILL) this.#state = "will";
          else if (b === WONT) this.#state = "wont";
          else if (b === DO) this.#state = "do";
          else if (b === DONT) this.#state = "dont";
          else if (b === SB) {
            this.#state = "sb";
            this.#sbOption = -1;
            this.#sbBuf = [];
          } else {
            // Standalone command: NOP, DM, GA, AYT, ...
            flush();
            this.#handleCommand(b);
            this.#state = "data";
          }
          break;

        case "will":
          flush();
          this.#recvWill(b);
          this.#state = "data";
          break;
        case "wont":
          flush();
          this.#recvWont(b);
          this.#state = "data";
          break;
        case "do":
          flush();
          this.#recvDo(b);
          this.#state = "data";
          break;
        case "dont":
          flush();
          this.#recvDont(b);
          this.#state = "data";
          break;

        case "sb":
          if (b === IAC) this.#state = "sb-iac";
          else if (this.#sbOption < 0) this.#sbOption = b;
          else this.#sbBuf.push(b);
          break;

        case "sb-iac":
          if (b === IAC) {
            this.#sbBuf.push(IAC);
            this.#state = "sb";
          } else if (b === SE) {
            flush();
            this.#handleSubnegotiation(this.#sbOption, this.#sbBuf);
            this.#state = "data";
          } else {
            // Malformed; resynchronise rather than die.
            this.#note(`malformed SB terminated by ${commandName(b)}`);
            this.#state = "data";
          }
          break;
      }
    }
    flush();
  }

  #note(line: string): void {
    this.negotiationLog.push(line);
    this.#events.onNegotiation?.(line);
  }

  #handleCommand(cmd: number): void {
    this.#note(`RECV ${commandName(cmd)}`);
    if (cmd === AYT) {
      // Be polite: something must come back so the peer knows we live.
      this.#writeRaw(new TextEncoder().encode("\r\n[genera-remote alive]\r\n"));
    }
    // NOP / DM / GA need no reply.  We do not implement out-of-band SYNCH;
    // Genera's server does not require the client to generate it.
  }

  #handleSubnegotiation(option: number, payload: number[]): void {
    if (option === OPT_TTYPE && payload[0] === TTYPE_SEND) {
      const list = this.terminalTypes;
      const name = list[Math.min(this.#ttypeIndex, list.length - 1)];
      this.#ttypeIndex++;
      this.#sentTerminalType = name;
      const bytes = new TextEncoder().encode(name);
      this.#writeRaw(
        new Uint8Array([IAC, SB, OPT_TTYPE, TTYPE_IS, ...bytes, IAC, SE]),
      );
      this.#note(`SEND SB TTYPE IS ${name}`);
      return;
    }
    this.#note(
      `RECV SB ${optionName(option)} (${payload.length} bytes, ignored)`,
    );
  }

  // -- negotiation state machine -------------------------------------------

  #recvDo(opt: number): void {
    this.#note(`RECV DO ${optionName(opt)}`);
    const st = this.#us.get(opt) ?? NO;
    if (st === WANTYES) {
      this.#us.set(opt, YES);
      this.#afterUsEnabled(opt);
    } else if (st === NO) {
      if (WE_SUPPORT.has(opt)) {
        this.#us.set(opt, YES);
        this.#send(WILL, opt);
        this.#afterUsEnabled(opt);
      } else {
        this.#send(WONT, opt);
      }
    } else if (st === WANTNO) {
      this.#us.set(opt, NO);
    }
    // st === YES: no state change, no reply.
  }

  #recvDont(opt: number): void {
    this.#note(`RECV DONT ${optionName(opt)}`);
    const st = this.#us.get(opt) ?? NO;
    if (st === YES) {
      this.#us.set(opt, NO);
      this.#send(WONT, opt);
    } else if (st === WANTYES || st === WANTNO) {
      this.#us.set(opt, NO);
    }
  }

  #recvWill(opt: number): void {
    this.#note(`RECV WILL ${optionName(opt)}`);
    const st = this.#him.get(opt) ?? NO;
    if (st === WANTYES) {
      this.#him.set(opt, YES);
    } else if (st === NO) {
      if (WE_WANT_HIM.has(opt)) {
        this.#him.set(opt, YES);
        this.#send(DO, opt);
      } else {
        this.#send(DONT, opt);
      }
    } else if (st === WANTNO) {
      this.#him.set(opt, NO);
    }
  }

  #recvWont(opt: number): void {
    this.#note(`RECV WONT ${optionName(opt)}`);
    const st = this.#him.get(opt) ?? NO;
    if (st === YES) {
      this.#him.set(opt, NO);
      this.#send(DONT, opt);
    } else if (st === WANTYES || st === WANTNO) {
      this.#him.set(opt, NO);
    }
  }

  #afterUsEnabled(opt: number): void {
    if (opt === OPT_NAWS) this.sendWindowSize();
  }

  #sendWill(opt: number): void {
    if ((this.#us.get(opt) ?? NO) === NO) {
      this.#us.set(opt, WANTYES);
      this.#send(WILL, opt);
    }
  }
  #sendDo(opt: number): void {
    if ((this.#him.get(opt) ?? NO) === NO) {
      this.#him.set(opt, WANTYES);
      this.#send(DO, opt);
    }
  }

  #send(cmd: number, opt: number): void {
    this.#note(`SEND ${commandName(cmd)} ${optionName(opt)}`);
    this.#writeRaw(new Uint8Array([IAC, cmd, opt]));
  }

  sendWindowSize(cols?: number, rows?: number): void {
    if (cols !== undefined) this.windowSize.cols = cols;
    if (rows !== undefined) this.windowSize.rows = rows;
    const { cols: c, rows: r } = this.windowSize;
    const raw = [c >> 8, c & 0xff, r >> 8, r & 0xff];
    // NAWS payload bytes equal to 255 must be doubled.
    const esc: number[] = [];
    for (const b of raw) {
      esc.push(b);
      if (b === IAC) esc.push(IAC);
    }
    this.#writeRaw(new Uint8Array([IAC, SB, OPT_NAWS, ...esc, IAC, SE]));
    this.#note(`SEND SB NAWS ${c}x${r}`);
  }

  /** Write application data, escaping IAC. */
  write(bytes: Uint8Array): void {
    const out: number[] = [];
    for (const b of bytes) {
      out.push(b);
      if (b === IAC) out.push(IAC);
    }
    this.#writeRaw(new Uint8Array(out));
  }

  writeText(text: string): void {
    this.write(new TextEncoder().encode(text));
  }

  #pending: Promise<void> = Promise.resolve();
  #writeRaw(bytes: Uint8Array): void {
    const conn = this.#conn;
    if (!conn) return;
    // Serialise writes; Deno.Conn.write may short-write.
    this.#pending = this.#pending.then(async () => {
      let off = 0;
      while (off < bytes.length) {
        off += await conn.write(bytes.subarray(off));
      }
    }).catch(() => {});
  }

  async flush(): Promise<void> {
    await this.#pending;
  }

  close(): void {
    this.#closed = true;
    try {
      this.#conn?.close();
    } catch (_e) { /* already gone */ }
    this.#conn = null;
  }
}

// ---------------------------------------------------------------------------
// Screen model — an X3.64 / ANSI character grid
// ---------------------------------------------------------------------------

export interface ScreenOptions {
  cols?: number;
  rows?: number;
  scrollbackLimit?: number;
  onUnknown?: (seq: string) => void;
  /** Sink for replies the terminal owes the host (e.g. cursor position). */
  onReply?: (text: string) => void;
}

/**
 * A character grid driven by the escape sequences Genera emits.
 *
 * Deliberately narrow: characters only, no attribute buffer.  SGR is parsed
 * and dropped.  Anything unrecognised is logged and ignored — never fatal,
 * because a mis-parse must not take down a live session.
 */
export class Screen {
  cols: number;
  rows: number;
  grid: string[][];
  cursorRow = 0;
  cursorCol = 0;
  scrollback: string[] = [];
  scrollbackLimit: number;
  /** Bumped on every change; `waitStable` watches it. */
  version = 0;
  readonly unknownSequences: string[] = [];

  #savedCursor: { row: number; col: number } | null = null;
  #scrollTop = 0;
  #scrollBottom: number;
  #onUnknown?: (seq: string) => void;
  #onReply?: (text: string) => void;

  // Parser state
  #state: "ground" | "esc" | "csi" | "osc" | "charset" = "ground";
  #params = "";
  #intermediates = "";
  #oscBuf = "";
  /** Pending wrap: cursor sits past the last column (DEC-style deferred wrap). */
  #wrapPending = false;

  constructor(opts: ScreenOptions = {}) {
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.scrollbackLimit = opts.scrollbackLimit ?? 2000;
    this.#onUnknown = opts.onUnknown;
    this.#onReply = opts.onReply;
    this.#scrollBottom = this.rows - 1;
    this.grid = this.#blankGrid();
  }

  #blankGrid(): string[][] {
    return Array.from(
      { length: this.rows },
      () => Array.from({ length: this.cols }, () => " "),
    );
  }

  #touch(): void {
    this.version++;
  }

  resize(cols: number, rows: number): void {
    const old = this.grid;
    this.cols = cols;
    this.rows = rows;
    this.#scrollTop = 0;
    this.#scrollBottom = rows - 1;
    this.grid = this.#blankGrid();
    for (let r = 0; r < Math.min(rows, old.length); r++) {
      for (let c = 0; c < Math.min(cols, old[r].length); c++) {
        this.grid[r][c] = old[r][c];
      }
    }
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorCol = Math.min(this.cursorCol, cols - 1);
    this.#touch();
  }

  // -- text access ---------------------------------------------------------

  /** The visible grid, one string per row, trailing blanks trimmed. */
  lines(): string[] {
    return this.grid.map((r) => r.join("").replace(/\s+$/, ""));
  }

  /**
   * The visible screen as text, with trailing all-blank rows dropped.  The
   * grid is a fixed 24 rows; keeping the empty tail just pads every read with
   * newlines, so it is trimmed for readability.  Interior blank lines stay.
   */
  text(): string {
    const rows = this.lines();
    let end = rows.length;
    while (end > 0 && rows[end - 1] === "") end--;
    return rows.slice(0, end).join("\n");
  }

  /** Scrollback plus the visible screen — a stable, growing transcript. */
  transcript(): string[] {
    return [...this.scrollback, ...this.lines()];
  }

  /**
   * Absolute index (into `transcript()`) of a visible row.  Stable as lines
   * scroll off, which is what makes eval's output extraction reliable.
   */
  absLine(row: number): number {
    return this.scrollback.length + row;
  }

  // -- the parser ----------------------------------------------------------

  write(text: string): void {
    for (const ch of text) this.#putChar(ch);
  }

  writeBytes(bytes: Uint8Array): void {
    // Genera speaks 8-bit; decode leniently so a stray high byte cannot throw.
    this.write(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  }

  #putChar(ch: string): void {
    const code = ch.codePointAt(0)!;
    switch (this.#state) {
      case "ground":
        this.#ground(ch, code);
        break;
      case "esc":
        this.#escape(ch, code);
        break;
      case "csi":
        this.#csi(ch, code);
        break;
      case "osc":
        // Terminated by BEL or ST (ESC \).
        if (code === 0x07) {
          this.#state = "ground";
          this.#oscBuf = "";
        } else if (ch === "\\" && this.#oscBuf.endsWith("\x1b")) {
          this.#state = "ground";
          this.#oscBuf = "";
        } else {
          this.#oscBuf += ch;
          if (this.#oscBuf.length > 512) { // runaway guard
            this.#unknown(`OSC overflow`);
            this.#state = "ground";
            this.#oscBuf = "";
          }
        }
        break;
      case "charset":
        // ESC ( X , ESC ) X — designate character set; consume and ignore.
        this.#state = "ground";
        break;
    }
  }

  #ground(ch: string, code: number): void {
    switch (code) {
      case 0x00:
        return; // NUL padding
      case 0x07:
        return; // BEL — nothing audible here
      case 0x08: // BS
        this.#wrapPending = false;
        if (this.cursorCol > 0) this.cursorCol--;
        this.#touch();
        return;
      case 0x09: { // TAB — 8-column stops
        this.#wrapPending = false;
        const next = Math.min(((this.cursorCol >> 3) + 1) << 3, this.cols - 1);
        this.cursorCol = next;
        this.#touch();
        return;
      }
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF — Genera uses this as "clear screen" on some streams,
        // but as a terminal control it is a line feed; ED handles clearing.
        this.#wrapPending = false;
        this.#lineFeed();
        return;
      case 0x0d: // CR
        this.#wrapPending = false;
        this.cursorCol = 0;
        this.#touch();
        return;
      case 0x1b:
        this.#state = "esc";
        this.#params = "";
        this.#intermediates = "";
        return;
      case 0x7f:
        return; // DEL as output — ignore
    }
    if (code < 0x20) return; // other C0: ignore
    this.#printable(ch);
  }

  #printable(ch: string): void {
    if (this.#wrapPending) {
      this.cursorCol = 0;
      this.#lineFeed();
      this.#wrapPending = false;
    }
    this.grid[this.cursorRow][this.cursorCol] = ch;
    if (this.cursorCol === this.cols - 1) {
      this.#wrapPending = true; // defer the wrap until the next printable
    } else {
      this.cursorCol++;
    }
    this.#touch();
  }

  #lineFeed(): void {
    if (this.cursorRow === this.#scrollBottom) this.#scrollUp(1);
    else if (this.cursorRow < this.rows - 1) this.cursorRow++;
    this.#touch();
  }

  #scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      const gone = this.grid.splice(this.#scrollTop, 1)[0];
      // Only lines leaving the top of the *screen* enter scrollback.
      if (this.#scrollTop === 0) {
        this.scrollback.push(gone.join("").replace(/\s+$/, ""));
        if (this.scrollback.length > this.scrollbackLimit) {
          this.scrollback.splice(
            0,
            this.scrollback.length - this.scrollbackLimit,
          );
        }
      }
      this.grid.splice(
        this.#scrollBottom,
        0,
        Array.from({ length: this.cols }, () => " "),
      );
    }
    this.#touch();
  }

  #scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.#scrollBottom, 1);
      this.grid.splice(
        this.#scrollTop,
        0,
        Array.from({ length: this.cols }, () => " "),
      );
    }
    this.#touch();
  }

  #escape(ch: string, code: number): void {
    switch (ch) {
      case "[":
        this.#state = "csi";
        this.#params = "";
        this.#intermediates = "";
        return;
      case "]":
        this.#state = "osc";
        this.#oscBuf = "";
        return;
      case "7":
        this.#savedCursor = { row: this.cursorRow, col: this.cursorCol };
        this.#state = "ground";
        return;
      case "8":
        if (this.#savedCursor) {
          this.cursorRow = this.#savedCursor.row;
          this.cursorCol = this.#savedCursor.col;
          this.#touch();
        }
        this.#state = "ground";
        return;
      case "D": // IND — index
        this.#lineFeed();
        this.#state = "ground";
        return;
      case "M": // RI — reverse index
        if (this.cursorRow === this.#scrollTop) this.#scrollDown(1);
        else if (this.cursorRow > 0) this.cursorRow--;
        this.#touch();
        this.#state = "ground";
        return;
      case "E": // NEL — next line
        this.cursorCol = 0;
        this.#lineFeed();
        this.#state = "ground";
        return;
      case "c": // RIS — full reset
        this.reset();
        this.#state = "ground";
        return;
      case "(":
      case ")":
      case "*":
      case "+":
        this.#state = "charset";
        return;
      case "=": // DECKPAM
      case ">": // DECKPNM
        this.#state = "ground";
        return;
      case "\\": // ST with no OSC open
        this.#state = "ground";
        return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#intermediates += ch; // collect and keep waiting for the final
      return;
    }
    this.#unknown(`ESC ${this.#intermediates}${ch}`);
    this.#state = "ground";
  }

  #csi(ch: string, code: number): void {
    // Parameter bytes 0x30-0x3f, intermediate 0x20-0x2f, final 0x40-0x7e.
    if (code >= 0x30 && code <= 0x3f) {
      this.#params += ch;
      if (this.#params.length > 64) { // runaway guard
        this.#unknown("CSI parameter overflow");
        this.#state = "ground";
      }
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.#intermediates += ch;
      return;
    }
    this.#dispatchCsi(ch);
    this.#state = "ground";
  }

  #nums(def = 0): number[] {
    const raw = this.#params.replace(/^[?<>=]/, "");
    if (raw === "") return [def];
    return raw.split(";").map((p) => (p === "" ? def : parseInt(p, 10) || 0));
  }

  #dispatchCsi(final: string): void {
    const priv = /^[?<>=]/.test(this.#params);
    const p = this.#nums(0);
    const p1 = (i = 0) => (p[i] === undefined || p[i] === 0 ? 1 : p[i]);
    this.#wrapPending = false;

    if (priv) {
      // DEC private modes (?25h cursor visibility, ?7h autowrap, ...).
      // None of them change the character grid; accept silently.
      if (final === "h" || final === "l") return;
      this.#unknown(`CSI ${this.#params}${final}`);
      return;
    }

    switch (final) {
      case "A": // CUU
        this.cursorRow = Math.max(0, this.cursorRow - p1());
        break;
      case "B": // CUD
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + p1());
        break;
      case "C": // CUF
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + p1());
        break;
      case "D": // CUB
        this.cursorCol = Math.max(0, this.cursorCol - p1());
        break;
      case "E": // CNL
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + p1());
        this.cursorCol = 0;
        break;
      case "F": // CPL
        this.cursorRow = Math.max(0, this.cursorRow - p1());
        this.cursorCol = 0;
        break;
      case "G": // CHA
      case "`": // HPA
        this.cursorCol = this.#clampCol(p1() - 1);
        break;
      case "d": // VPA
        this.cursorRow = this.#clampRow(p1() - 1);
        break;
      case "H": // CUP
      case "f": // HVP
        this.cursorRow = this.#clampRow(p1(0) - 1);
        this.cursorCol = this.#clampCol(p1(1) - 1);
        break;
      case "J":
        this.#eraseDisplay(p[0] ?? 0);
        break;
      case "K":
        this.#eraseLine(p[0] ?? 0);
        break;
      case "L":
        this.#insertLines(p1());
        break;
      case "M":
        this.#deleteLines(p1());
        break;
      case "@":
        this.#insertChars(p1());
        break;
      case "P":
        this.#deleteChars(p1());
        break;
      case "X": { // ECH — erase characters
        const n = Math.min(p1(), this.cols - this.cursorCol);
        for (let i = 0; i < n; i++) {
          this.grid[this.cursorRow][this.cursorCol + i] = " ";
        }
        break;
      }
      case "S":
        this.#scrollUp(p1());
        break;
      case "T":
        this.#scrollDown(p1());
        break;
      case "r": { // DECSTBM
        const top = (p[0] ?? 1) - 1;
        const bot = (p[1] ?? this.rows) - 1;
        if (top >= 0 && bot < this.rows && top < bot) {
          this.#scrollTop = top;
          this.#scrollBottom = bot;
        } else {
          this.#scrollTop = 0;
          this.#scrollBottom = this.rows - 1;
        }
        this.cursorRow = this.#scrollTop;
        this.cursorCol = 0;
        break;
      }
      case "m": // SGR — parsed, deliberately not rendered
        break;
      case "n": // DSR
        if ((p[0] ?? 0) === 6) {
          this.#onReply?.(
            `\x1b[${this.cursorRow + 1};${this.cursorCol + 1}R`,
          );
        } else if ((p[0] ?? 0) === 5) {
          this.#onReply?.("\x1b[0n");
        }
        break;
      case "s":
        this.#savedCursor = { row: this.cursorRow, col: this.cursorCol };
        break;
      case "u":
        if (this.#savedCursor) {
          this.cursorRow = this.#savedCursor.row;
          this.cursorCol = this.#savedCursor.col;
        }
        break;
      case "c": // DA — device attributes; claim to be a plain VT100
        this.#onReply?.("\x1b[?1;0c");
        break;
      case "g": // TBC — tab clear; we use fixed stops
        break;
      case "h":
      case "l": // ANSI modes (IRM etc.) — no grid effect here
        break;
      default:
        this.#unknown(`CSI ${this.#params}${this.#intermediates}${final}`);
        return;
    }
    this.#touch();
  }

  #clampRow(r: number): number {
    return Math.max(0, Math.min(this.rows - 1, r));
  }
  #clampCol(c: number): number {
    return Math.max(0, Math.min(this.cols - 1, c));
  }

  #blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  #eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.#eraseLine(0);
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        this.grid[r] = this.#blankRow();
      }
    } else if (mode === 1) {
      this.#eraseLine(1);
      for (let r = 0; r < this.cursorRow; r++) this.grid[r] = this.#blankRow();
    } else {
      // mode 2 (and 3): clear the whole screen.  Genera repaints from
      // scratch often; pushing the old screen to scrollback would double
      // every line, so the cleared content is simply dropped.
      for (let r = 0; r < this.rows; r++) this.grid[r] = this.#blankRow();
    }
  }

  #eraseLine(mode: number): void {
    const row = this.grid[this.cursorRow];
    if (mode === 0) {
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = " ";
    } else if (mode === 1) {
      for (let c = 0; c <= this.cursorCol && c < this.cols; c++) row[c] = " ";
    } else for (let c = 0; c < this.cols; c++) row[c] = " ";
  }

  #insertLines(n: number): void {
    if (
      this.cursorRow < this.#scrollTop || this.cursorRow > this.#scrollBottom
    ) {
      return;
    }
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.#scrollBottom, 1);
      this.grid.splice(this.cursorRow, 0, this.#blankRow());
    }
  }

  #deleteLines(n: number): void {
    if (
      this.cursorRow < this.#scrollTop || this.cursorRow > this.#scrollBottom
    ) {
      return;
    }
    for (let i = 0; i < n; i++) {
      this.grid.splice(this.cursorRow, 1);
      this.grid.splice(this.#scrollBottom, 0, this.#blankRow());
    }
  }

  #insertChars(n: number): void {
    const row = this.grid[this.cursorRow];
    for (let i = 0; i < n; i++) {
      row.splice(this.cursorCol, 0, " ");
      row.length = this.cols;
    }
  }

  #deleteChars(n: number): void {
    const row = this.grid[this.cursorRow];
    for (let i = 0; i < n; i++) {
      row.splice(this.cursorCol, 1);
      row.push(" ");
    }
  }

  #unknown(seq: string): void {
    const printable = seq.split("\x1b").join("ESC");
    this.unknownSequences.push(printable);
    if (this.unknownSequences.length > 200) this.unknownSequences.shift();
    this.#onUnknown?.(printable);
  }

  reset(): void {
    this.grid = this.#blankGrid();
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.#savedCursor = null;
    this.#scrollTop = 0;
    this.#scrollBottom = this.rows - 1;
    this.#wrapPending = false;
    this.#touch();
  }
}

// ---------------------------------------------------------------------------
// Key map — Genera keys reachable from an ASCII keyboard
// ---------------------------------------------------------------------------
//
// See the README for where each of these comes from.  Entries carry their
// provenance so a wrong guess is visible rather than folklore.

export interface KeyDef {
  bytes: number[];
  note: string;
}

// The mapping is exact, from the Genera server's own input filter:
//   network/remote-terminal.lisp — CONVERT-ASCII-TO-LISPM (control codes),
//   ASCII-TERMINAL-FILTER + SPECIAL-KEYS (the c-_ table), CONTROL-ESCAPE &c.
// A special key is the prefix c-_ (0x1F) followed by a letter; the lookup is
// case-insensitive on the server.  Modifier prefixes toggle a Bucky bit for
// the *next* character sent, so `genera_key Control` then `genera_type "a"`
// yields Control-A.  Notes cite the behaviour so a wrong guess is visible.
const SK = 0x1f; // c-_  SPECIAL-KEY-ESCAPE

export const KEY_MAP: Record<string, KeyDef> = {
  // -- plain control codes (CONVERT-ASCII-TO-LISPM) ------------------------
  Return: { bytes: [0x0d], note: "CR 0x0D -> #\\RETURN" },
  Line: { bytes: [0x0a], note: "LF 0x0A -> #\\LINE" },
  Tab: { bytes: [0x09], note: "HT 0x09 -> #\\TAB" },
  Rubout: {
    bytes: [0x7f],
    note: "DEL 0x7F -> #\\RUBOUT (verified interactively)",
  },

  // -- special keys: c-_ (0x1F) + letter (SPECIAL-KEYS table) --------------
  Help: { bytes: [SK, 0x48], note: "c-_ H -> #\\HELP" },
  End: { bytes: [SK, 0x45], note: "c-_ E -> #\\END (bare 0x08 also -> End)" },
  Abort: { bytes: [SK, 0x41], note: "c-_ A -> #\\ABORT (the interrupt char)" },
  Suspend: { bytes: [SK, 0x53], note: "c-_ S -> #\\SUSPEND" },
  Resume: { bytes: [SK, 0x52], note: "c-_ R -> #\\RESUME" },
  Complete: { bytes: [SK, 0x43], note: "c-_ C -> #\\COMPLETE" },
  "Clear-Input": { bytes: [SK, 0x49], note: "c-_ I -> #\\CLEAR-INPUT" },
  Escape: {
    bytes: [SK, 0x58],
    note: "c-_ X -> #\\ESCAPE (bare 0x1B is the Meta prefix)",
  },
  Page: { bytes: [SK, 0x50], note: "c-_ P -> #\\PAGE" },
  Refresh: { bytes: [SK, 0x46], note: "c-_ F -> #\\REFRESH" },
  Backspace: {
    bytes: [SK, 0x42],
    note: "c-_ B -> #\\BACKSPACE (bare 0x08 maps to End!)",
  },
  Network: { bytes: [SK, 0x4e], note: "c-_ N -> #\\NETWORK" },
  Square: { bytes: [SK, 0x31], note: "c-_ 1 -> #\\SQUARE" },
  Circle: { bytes: [SK, 0x32], note: "c-_ 2 -> #\\CIRCLE" },
  Triangle: { bytes: [SK, 0x33], note: "c-_ 3 -> #\\TRIANGLE" },
  Status: { bytes: [SK, 0x57], note: "c-_ W -> refresh who-line/status" },

  // -- modifier prefixes: toggle a Bucky bit for the next char sent --------
  Meta: {
    bytes: [0x1b],
    note: "ESC 0x1B -> Meta prefix (toggles for next char)",
  },
  Control: {
    bytes: [0x1e],
    note: "c-^ 0x1E -> Control prefix (toggles for next char)",
  },
  Super: {
    bytes: [0x1d],
    note: "c-] 0x1D -> Super prefix (toggles for next char)",
  },
  Hyper: {
    bytes: [0x1c],
    note: "c-\\ 0x1C -> Hyper prefix (toggles for next char)",
  },
  Shift: {
    bytes: [0x00],
    note: "c-@ 0x00 -> Shift prefix (toggles for next char)",
  },
  Symbol: {
    bytes: [SK, SK],
    note: "c-_ c-_ -> Symbol prefix (next char from symbol table)",
  },
  // NOTE: Genera's #\FUNCTION and #\SELECT keys have NO byte sequence in the
  // server's SPECIAL-KEYS table, so they are deliberately absent here.
};

export function keyNames(): string[] {
  return Object.keys(KEY_MAP).sort();
}

export function lookupKey(name: string): KeyDef | null {
  const k = name.toLowerCase();
  for (const [n, d] of Object.entries(KEY_MAP)) {
    if (n.toLowerCase() === k) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session — telnet + screen, with wait/eval semantics on top
// ---------------------------------------------------------------------------

export interface ActionLogEntry {
  time: string;
  intent: string;
  outcome: string;
}

export interface SessionOptions {
  host?: string;
  port?: number;
  cols?: number;
  rows?: number;
  terminalTypes?: string[];
  promptPattern?: RegExp;
  logLimit?: number;
}

export const DEFAULT_HOST = "192.168.2.2";
export const DEFAULT_PORT = 23;

/**
 * Genera's command loop paints a prompt and leaves the cursor just past it.
 * We detect "at a prompt" by matching the cursor row's text *up to the
 * cursor*, so an echoed form on the same line prevents a false positive.
 */
export const DEFAULT_PROMPT_PATTERN =
  /(?:^|\s)(?:Command:|Eval:|Lisp>|[A-Za-z0-9 .*+-]*(?:>|»))\s*$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeneraSession {
  screen: Screen;
  telnet: TelnetClient | null = null;
  host: string;
  port: number;
  promptPattern: RegExp;
  readonly actionLog: ActionLogEntry[] = [];
  #logLimit: number;
  #opts: SessionOptions;
  #lastChangeAt = 0;
  #connectedAt: string | null = null;
  #closeReason: string | null = null;

  constructor(opts: SessionOptions = {}) {
    this.#opts = opts;
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.promptPattern = opts.promptPattern ?? DEFAULT_PROMPT_PATTERN;
    this.#logLimit = opts.logLimit ?? 500;
    this.screen = new Screen({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      onReply: (t) => this.telnet?.writeText(t),
    });
    this.#lastChangeAt = Date.now();
  }

  get connected(): boolean {
    return this.telnet?.connected ?? false;
  }

  note(intent: string, outcome: string): ActionLogEntry {
    const entry = {
      time: new Date().toISOString(),
      intent,
      outcome,
    };
    this.actionLog.push(entry);
    if (this.actionLog.length > this.#logLimit) this.actionLog.shift();
    return entry;
  }

  async connect(host?: string, port?: number): Promise<ActionLogEntry> {
    if (this.connected) {
      return this.note(
        "connect",
        `already connected to ${this.host}:${this.port}`,
      );
    }
    this.host = host ?? this.host;
    this.port = port ?? this.port;
    this.screen.reset();
    this.screen.scrollback.length = 0;
    this.#closeReason = null;
    const tn = new TelnetClient({
      onData: (b) => {
        this.screen.writeBytes(b);
        this.#lastChangeAt = Date.now();
      },
      onClose: () => {
        this.#closeReason = "peer closed the connection";
        this.#lastChangeAt = Date.now();
      },
    }, {
      terminalTypes: this.#opts.terminalTypes,
      cols: this.screen.cols,
      rows: this.screen.rows,
    });
    try {
      await tn.connect(this.host, this.port);
    } catch (e) {
      return this.note(
        `connect ${this.host}:${this.port}`,
        `FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.telnet = tn;
    this.#connectedAt = new Date().toISOString();
    this.#lastChangeAt = Date.now();
    return this.note(
      `connect ${this.host}:${this.port}`,
      "connected",
    );
  }

  disconnect(): ActionLogEntry {
    if (!this.telnet) return this.note("disconnect", "was not connected");
    this.telnet.close();
    this.telnet = null;
    this.#connectedAt = null;
    return this.note("disconnect", "closed");
  }

  /** State summary shared by every tool result. */
  state(): Record<string, unknown> {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      connectedAt: this.#connectedAt,
      closeReason: this.#closeReason,
      cols: this.screen.cols,
      rows: this.screen.rows,
      cursor: { row: this.screen.cursorRow, col: this.screen.cursorCol },
      terminalType: this.telnet?.negotiatedTerminalType ?? null,
      serverEchoes: this.telnet?.serverEchoes ?? false,
      nawsAccepted: this.telnet?.nawsAccepted ?? false,
      atPrompt: this.atPrompt(),
      scrollbackLines: this.screen.scrollback.length,
    };
  }

  #requireConnection(): void {
    if (!this.connected) {
      throw new Error(
        `not connected (host ${this.host}:${this.port}) — call genera_connect first`,
      );
    }
  }

  type(text: string): ActionLogEntry {
    this.#requireConnection();
    this.telnet!.writeText(text);
    return this.note(
      `type ${JSON.stringify(text)}`,
      `sent ${text.length} chars`,
    );
  }

  key(name: string): ActionLogEntry {
    this.#requireConnection();
    const def = lookupKey(name);
    if (!def) {
      throw new Error(
        `unknown key ${JSON.stringify(name)}; known keys: ${
          keyNames().join(", ")
        }`,
      );
    }
    this.telnet!.write(new Uint8Array(def.bytes));
    return this.note(
      `key ${name}`,
      `sent ${
        def.bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(" ")
      } (${def.note})`,
    );
  }

  /** Text of the cursor row up to the cursor — where a prompt would sit. */
  promptLine(): string {
    return this.screen.grid[this.screen.cursorRow]
      .join("")
      .slice(0, this.screen.cursorCol);
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
   * Type a form, wait for the next prompt, and return exactly what the
   * Listener printed in between.
   *
   * The echoed form is stripped from the first line; the trailing prompt line
   * is excluded by construction (we slice up to it).
   */
  async evalForm(
    form: string,
    timeoutMs = 30_000,
  ): Promise<{ output: string; timedOut: boolean; elapsedMs: number }> {
    this.#requireConnection();
    const start = Date.now();
    const mark = this.screen.absLine(this.screen.cursorRow);
    this.telnet!.writeText(form + "\r");
    this.note(`eval ${JSON.stringify(form)}`, "form sent, awaiting prompt");

    let timedOut = false;
    while (true) {
      const here = this.screen.absLine(this.screen.cursorRow);
      if (this.atPrompt() && here > mark) break;
      if (Date.now() - start >= timeoutMs) {
        timedOut = true;
        break;
      }
      if (!this.connected) break;
      await sleep(15);
    }

    const promptAbs = this.screen.absLine(this.screen.cursorRow);
    const all = this.screen.transcript();
    const end = timedOut ? all.length : Math.max(mark, promptAbs);
    const lines = all.slice(mark, end);

    if (lines.length) {
      const i = lines[0].indexOf(form);
      // The prompt and the echoed form share the first line; drop both.
      if (i >= 0) lines[0] = lines[0].slice(i + form.length);
      else lines.shift();
    }
    const output = lines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
    this.note(
      `eval ${JSON.stringify(form)}`,
      timedOut
        ? `TIMED OUT after ${Date.now() - start}ms`
        : `ok (${output.length} chars)`,
    );
    return { output, timedOut, elapsedMs: Date.now() - start };
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
    this.telnet?.sendWindowSize(cols, rows);
  }
}

// ---------------------------------------------------------------------------
// MCP stdio server
// ---------------------------------------------------------------------------
//
// The SDK is imported dynamically so that the telnet client and screen model
// above stay dependency-free: `deno test` never pulls npm, and a bad SDK can
// only break the MCP entry point, not the core.

/** Pin the SDK version we verified in the Deno cache. */
const MCP_SDK = "npm:@modelcontextprotocol/sdk@1.29.0";
const ZOD = "npm:zod@3.25.76";

export async function runMcpServer(session: GeneraSession): Promise<void> {
  const { McpServer } = await import(`${MCP_SDK}/server/mcp.js`);
  const { StdioServerTransport } = await import(`${MCP_SDK}/server/stdio.js`);
  const { z } = await import(ZOD);

  const server = new McpServer({ name: "genera-remote", version: "1.0.0" });

  // Every tool result carries the current state, its own action-log entry,
  // and (usually) the screen — so the caller always knows where things stand.
  const ok = (
    entry: ActionLogEntry,
    extra: Record<string, unknown> = {},
    screen = true,
  ) => {
    const payload: Record<string, unknown> = {
      action: entry,
      state: session.state(),
      ...extra,
    };
    if (screen) {
      payload.screen = session.screen.text();
      payload.cursor = {
        row: session.screen.cursorRow,
        col: session.screen.cursorCol,
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      }],
    };
  };
  const fail = (message: string) => ({
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: message, state: session.state() }, null, 2),
    }],
  });

  server.registerTool("genera_connect", {
    title: "Connect to Genera",
    description:
      "Open a telnet session to the Genera Lisp Listener. Defaults to the vmnet bridge guest address.",
    inputSchema: {
      host: z.string().optional().describe(`host (default ${DEFAULT_HOST})`),
      port: z.number().int().optional().describe(
        `port (default ${DEFAULT_PORT})`,
      ),
    },
  }, async ({ host, port }: { host?: string; port?: number }) => {
    const entry = await session.connect(host, port);
    if (!session.connected) return fail(entry.outcome);
    // Give the herald a moment to paint before the first screen read.
    await session.wait({ stableMs: 400, timeoutMs: 4000 });
    return ok(session.note("connect", "settled"), {});
  });

  server.registerTool("genera_disconnect", {
    title: "Disconnect",
    description: "Close the telnet session.",
    inputSchema: {},
  }, () => ok(session.disconnect(), {}, false));

  server.registerTool("genera_screen", {
    title: "Read the screen",
    description:
      "Return the current character grid as text, plus cursor position and connection state.",
    inputSchema: {},
  }, () => ok(session.note("screen", "read"), {}));

  server.registerTool("genera_type", {
    title: "Type text",
    description: "Send literal text to Genera (no newline appended).",
    inputSchema: { text: z.string().describe("text to send verbatim") },
  }, ({ text }: { text: string }) => {
    try {
      return ok(session.type(text));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool("genera_key", {
    title: "Press a named key",
    description: `Send a named Genera key. Known: ${keyNames().join(", ")}.`,
    inputSchema: {
      name: z.string().describe("key name, e.g. Return, Rubout, Abort"),
    },
  }, ({ name }: { name: string }) => {
    try {
      return ok(session.key(name));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool(
    "genera_wait",
    {
      title: "Wait for the screen",
      description:
        "Wait until a regex appears on screen, OR the screen is unchanged for stable_ms. Always returns the final screen. Fails closed on timeout.",
      inputSchema: {
        pattern: z.string().optional().describe("regex to wait for"),
        stable_ms: z.number().int().optional().describe(
          "ms of no change to accept",
        ),
        timeout_ms: z.number().int().optional().describe(
          "give up after this many ms",
        ),
      },
    },
    async (
      { pattern, stable_ms, timeout_ms }: {
        pattern?: string;
        stable_ms?: number;
        timeout_ms?: number;
      },
    ) => {
      if (!session.connected) return fail("not connected");
      const r = await session.wait({
        pattern,
        stableMs: stable_ms,
        timeoutMs: timeout_ms,
      });
      const entry = session.note(
        `wait ${pattern ? JSON.stringify(pattern) : "(stable)"}`,
        r.matched ? "matched" : r.stable ? "settled" : "TIMED OUT",
      );
      const res = ok(entry, { wait: r });
      if (r.timedOut) (res as { isError?: boolean }).isError = true;
      return res;
    },
  );

  server.registerTool("genera_eval", {
    title: "Evaluate a form",
    description:
      "Type a Lisp form + Return, wait for the next prompt, and return exactly the output printed in between.",
    inputSchema: {
      form: z.string().describe("the form to evaluate"),
      timeout_ms: z.number().int().optional().describe(
        "give up after this many ms",
      ),
    },
  }, async ({ form, timeout_ms }: { form: string; timeout_ms?: number }) => {
    if (!session.connected) return fail("not connected");
    const r = await session.evalForm(form, timeout_ms ?? 30_000);
    const entry = session.note(
      `eval ${JSON.stringify(form)}`,
      r.timedOut ? "TIMED OUT" : "ok",
    );
    const res = ok(entry, {
      output: r.output,
      timedOut: r.timedOut,
      elapsedMs: r.elapsedMs,
    });
    if (r.timedOut) (res as { isError?: boolean }).isError = true;
    return res;
  });

  server.registerTool("genera_log", {
    title: "Session action log",
    description:
      "Return the in-memory action log (timestamp, intent, outcome per entry).",
    inputSchema: {
      limit: z.number().int().optional().describe("last N entries"),
    },
  }, ({ limit }: { limit?: number }) => {
    const log = limit
      ? session.actionLog.slice(-limit)
      : session.actionLog.slice();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ log, count: log.length }, null, 2),
      }],
    };
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
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOpts {
  host: string;
  port: number;
  json: boolean;
  pattern?: string;
  stableMs?: number;
  timeoutMs?: number;
  rest: string[];
}

function parseCli(argv: string[]): { verb: string; opts: CliOpts } {
  const rest: string[] = [];
  const opts: CliOpts = {
    host: Deno.env.get("GENERA_HOST") ?? DEFAULT_HOST,
    port: parseInt(Deno.env.get("GENERA_PORT") ?? String(DEFAULT_PORT), 10),
    json: false,
    rest,
  };
  let verb = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") opts.host = argv[++i];
    else if (a === "--port") opts.port = parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--pattern") opts.pattern = argv[++i];
    else if (a === "--stable-ms") opts.stableMs = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") opts.timeoutMs = parseInt(argv[++i], 10);
    else if (!verb) verb = a;
    else rest.push(a);
  }
  return { verb, opts };
}

const CLI_USAGE = `genera-remote — drive a Genera Lisp Listener over telnet

USAGE:
  genera-remote.ts <verb> [args] [--host H] [--port N] [--json]

VERBS:
  mcp                        run as an MCP stdio server (default when no verb)
  screen                     connect, print the screen, disconnect
  type <text>                type literal text
  key <name>                 press a named key (${"see 'keys'"})
  keys                       list known key names
  wait [--pattern RE] [--stable-ms N] [--timeout-ms N]
  eval <form> [--timeout-ms N]   evaluate a form, print its output
  repl                       interactive line-mode session (stays connected)

OPTIONS:
  --host H     default ${DEFAULT_HOST} (env GENERA_HOST)
  --port N     default ${DEFAULT_PORT}  (env GENERA_PORT)
  --json       machine-readable output where applicable

Per-invocation verbs (screen/type/key/wait/eval) connect, act, and disconnect.
Use 'repl' to hold one login open across many commands.`;

async function cliMain(verb: string, opts: CliOpts): Promise<number> {
  const out = (s: string) => console.log(s);
  const session = new GeneraSession({ host: opts.host, port: opts.port });

  const settle = () => session.wait({ stableMs: 400, timeoutMs: 4000 });

  switch (verb) {
    case "keys": {
      for (const n of keyNames()) {
        const d = lookupKey(n)!;
        out(
          `${n.padEnd(14)} ${
            d.bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(" ")
              .padEnd(20)
          } ${d.note}`,
        );
      }
      return 0;
    }
    case "repl":
      return await cliRepl(session, opts);
    case "screen":
    case "type":
    case "key":
    case "wait":
    case "eval": {
      const entry = await session.connect();
      if (!session.connected) {
        console.error(`connect failed: ${entry.outcome}`);
        return 1;
      }
      await settle();
      let code = 0;
      let result: unknown = null;
      try {
        switch (verb) {
          case "screen":
            result = { screen: session.screen.text(), state: session.state() };
            break;
          case "type":
            session.type(opts.rest.join(" "));
            await settle();
            result = { screen: session.screen.text(), state: session.state() };
            break;
          case "key":
            session.key(opts.rest[0] ?? "");
            await settle();
            result = { screen: session.screen.text(), state: session.state() };
            break;
          case "wait": {
            const r = await session.wait({
              pattern: opts.pattern,
              stableMs: opts.stableMs,
              timeoutMs: opts.timeoutMs,
            });
            result = { wait: r, screen: session.screen.text() };
            if (r.timedOut) code = 2;
            break;
          }
          case "eval": {
            const r = await session.evalForm(
              opts.rest.join(" "),
              opts.timeoutMs ?? 30_000,
            );
            result = {
              output: r.output,
              timedOut: r.timedOut,
              screen: session.screen.text(),
            };
            if (r.timedOut) code = 2;
            break;
          }
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        code = 1;
      }
      session.disconnect();
      if (opts.json) out(JSON.stringify(result, null, 2));
      else if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if ("output" in r) out(String(r.output));
        else if ("screen" in r) out(String(r.screen));
        else out(JSON.stringify(r, null, 2));
      }
      return code;
    }
    default:
      console.error(CLI_USAGE);
      return verb ? 1 : 0;
  }
}

async function cliRepl(
  session: GeneraSession,
  _opts: CliOpts,
): Promise<number> {
  const entry = await session.connect();
  if (!session.connected) {
    console.error(`connect failed: ${entry.outcome}`);
    return 1;
  }
  await session.wait({ stableMs: 400, timeoutMs: 4000 });
  console.error(session.screen.text());
  console.error(
    "\n[genera-remote repl] blank line = Return; /screen /keys /key NAME /wait /quit\n",
  );

  const dec = new TextDecoder();
  const buf = new Uint8Array(1024);
  let pending = "";
  let quit = false;

  const handleLine = async (line: string): Promise<void> => {
    if (line === "/quit") {
      quit = true;
      return;
    }
    if (line === "/screen") {
      console.error(session.screen.text());
      return;
    }
    if (line === "/keys") {
      console.error(keyNames().join(", "));
      return;
    }
    if (line.startsWith("/key ")) {
      try {
        session.key(line.slice(5).trim());
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return;
      }
      await session.wait({ stableMs: 300, timeoutMs: 4000 });
      console.error(session.screen.text());
      return;
    }
    if (line === "/wait") {
      await session.wait({ stableMs: 400, timeoutMs: 10000 });
      console.error(session.screen.text());
      return;
    }
    // Anything else is typed as a form + Return.
    session.type(line + "\r");
    await session.wait({ stableMs: 400, timeoutMs: 10000 });
    console.error(session.screen.text());
  };

  while (!quit) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    pending += dec.decode(buf.subarray(0, n));
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0 && !quit) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      await handleLine(line);
    }
  }
  session.disconnect();
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { verb, opts } = parseCli(Deno.args);
  if (verb === "" || verb === "mcp") {
    const session = new GeneraSession({ host: opts.host, port: opts.port });
    await runMcpServer(session);
    Deno.exit(0);
  } else if (verb === "-h" || verb === "--help" || verb === "help") {
    console.log(CLI_USAGE);
    Deno.exit(0);
  } else {
    Deno.exit(await cliMain(verb, opts));
  }
}
