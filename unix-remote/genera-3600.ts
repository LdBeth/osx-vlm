/**
 * genera-3600 — codec for Genera's native remote terminal, 3600-LOGIN (TCP 57).
 *
 * No I/O here: the caller owns the socket.  This module turns server output
 * bytes into display operations, applies them to a character grid or to an
 * xterm, and encodes keyboard input.
 *
 * Server side reference (read-only), rel-9-0 tree:
 *   sys.sct/network/network-terminal.lisp  — flavor 3600-TERMINAL,
 *       (:LISPM-CHAR 3600-TERMINAL) for input, DEFINE-3600-TERMINAL-OPERATIONS
 *       for output;
 *   sys.sct/network/remote-terminal.lisp   — REMOTE-TERMINAL's raw cursor
 *       model (NEW-LINE-RAW sets RAW-LINE-CLEAR? T, so the server never sends
 *       a clear-to-end-of-line after a newline: the client clears the row).
 *
 * Output stream (server -> client):
 *   0..0177  a character, printed at the cursor, which advances.  The
 *            3600-TERMINAL sets SAIL-DISPLAY? T, so codes 0..037 (and 0177)
 *            arrive raw as Lisp Machine graphic characters (SAIL glyphs).
 *            Characters >= 0200 never arrive raw; the server writes them as
 *            `<Name>` text.
 *   0200 beep                     0204 clear to end of line
 *   0201 newline (col 0, next     0205 n    insert n chars
 *        row, and clear that row) 0206 n    delete n chars
 *   0202 clear window and home    0207 x y  set cursor (column first)
 *   0203 clear to end of window
 *
 * Input stream (client -> server), per (:LISPM-CHAR 3600-TERMINAL):
 *   0              logout
 *   1 cols rows    screen size (send within the ~2 s init window, and on resize)
 *   2 len bytes..  console location string
 *   3 bits code    one Genera character; bits: control 1, meta 2, super 4,
 *                  hyper 8.  Any other lead byte makes the server FERROR.
 */

// ---------------------------------------------------------------------------
// Output decoder
// ---------------------------------------------------------------------------

export const OP = {
  BEEP: 0o200,
  NEWLINE: 0o201,
  CLEAR: 0o202,
  CLEAR_EOW: 0o203,
  CLEAR_EOL: 0o204,
  INSERT_CHARS: 0o205,
  DELETE_CHARS: 0o206,
  SET_CURSOR: 0o207,
} as const;

export type Op3600 =
  | { op: "char"; code: number }
  | { op: "beep" }
  | { op: "newline" }
  | { op: "clear" }
  | { op: "clearEow" }
  | { op: "clearEol" }
  | { op: "insertChars"; n: number }
  | { op: "deleteChars"; n: number }
  | { op: "move"; x: number; y: number }
  | { op: "unknown"; byte: number };

/**
 * Byte state machine for 3600-TERMINAL output.  Keeps its state across
 * `feed` calls, so an op split over TCP chunks decodes the same as whole.
 */
export class Decoder3600 {
  /** The op byte awaiting arguments, or 0 when in ground state. */
  #pending = 0;
  #args: number[] = [];

  reset(): void {
    this.#pending = 0;
    this.#args = [];
  }

  feed(bytes: Uint8Array | number[]): Op3600[] {
    const out: Op3600[] = [];
    for (const b of bytes) {
      if (this.#pending) {
        this.#args.push(b);
        const need = this.#pending === OP.SET_CURSOR ? 2 : 1;
        if (this.#args.length < need) continue;
        const [a0, a1] = this.#args;
        if (this.#pending === OP.INSERT_CHARS) {
          out.push({ op: "insertChars", n: a0 });
        } else if (this.#pending === OP.DELETE_CHARS) {
          out.push({ op: "deleteChars", n: a0 });
        } else out.push({ op: "move", x: a0, y: a1 });
        this.reset();
        continue;
      }
      if (b < 0o200) {
        out.push({ op: "char", code: b });
        continue;
      }
      switch (b) {
        case OP.BEEP:
          out.push({ op: "beep" });
          break;
        case OP.NEWLINE:
          out.push({ op: "newline" });
          break;
        case OP.CLEAR:
          out.push({ op: "clear" });
          break;
        case OP.CLEAR_EOW:
          out.push({ op: "clearEow" });
          break;
        case OP.CLEAR_EOL:
          out.push({ op: "clearEol" });
          break;
        case OP.INSERT_CHARS:
        case OP.DELETE_CHARS:
        case OP.SET_CURSOR:
          this.#pending = b;
          this.#args = [];
          break;
        default:
          out.push({ op: "unknown", byte: b });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// SAIL glyphs: Lisp Machine graphic characters 0..037 and 0177
// ---------------------------------------------------------------------------

/** Unicode for Genera codes 0..037, index = code. */
export const SAIL_GLYPHS: readonly string[] = [
  "·", "↓", "α", "β", "∧", "¬", "ε", "π",
  "λ", "γ", "δ", "↑", "±", "⊕", "∞", "∂",
  "⊂", "⊃", "∩", "∪", "∀", "∃", "⊗", "↔",
  "←", "→", "≠", "◊", "≤", "≥", "≡", "∨",
];
/** Genera code 0177 is the integral sign in the Lisp Machine character set. */
export const INTEGRAL_GLYPH = "∫";

const GLYPH_TO_CODE = new Map<string, number>(
  [
    ...SAIL_GLYPHS.map((g, i) => [g, i] as [string, number]),
    [INTEGRAL_GLYPH, 0o177],
  ],
);

/** Display string for a raw output code 0..0177. */
export function glyphFor(code: number): string {
  if (code < 0o40) return SAIL_GLYPHS[code];
  if (code === 0o177) return INTEGRAL_GLYPH;
  return String.fromCharCode(code);
}

// ---------------------------------------------------------------------------
// Screen: a character grid for the MCP layer
// ---------------------------------------------------------------------------

export interface ScreenOptions {
  cols?: number;
  rows?: number;
}

/**
 * The terminal as a grid.  One cell per character (all Genera characters on
 * the 3600 terminal have the same width).  Out-of-range moves clamp; a
 * newline on the last row scrolls the grid up one row, with no scrollback.
 * Characters written past the right edge are dropped (the server does not
 * wrap: remote-terminal.lisp breaks lines itself), and `cursorCol` may then
 * rest at `cols`.
 */
export class Screen {
  cols: number;
  rows: number;
  grid: string[][];
  cursorRow = 0;
  cursorCol = 0;
  /** Bumped on every change; `waitStable` watches it. */
  version = 0;
  /** Beeps received since the last reset. */
  beeps = 0;
  /** Op bytes 0200+ that the decoder did not recognise. */
  readonly unknownBytes: number[] = [];

  #decoder = new Decoder3600();

  constructor(opts: ScreenOptions = {}) {
    this.cols = Math.max(1, opts.cols ?? 80);
    this.rows = Math.max(1, opts.rows ?? 24);
    this.grid = this.#blankGrid();
  }

  #blankRow(): string[] {
    return Array.from({ length: this.cols }, () => " ");
  }

  #blankGrid(): string[][] {
    return Array.from({ length: this.rows }, () => this.#blankRow());
  }

  #touch(): void {
    this.version++;
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    const old = this.grid;
    this.cols = cols;
    this.rows = rows;
    this.grid = this.#blankGrid();
    for (let r = 0; r < Math.min(rows, old.length); r++) {
      for (let c = 0; c < Math.min(cols, old[r].length); c++) {
        this.grid[r][c] = old[r][c];
      }
    }
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorCol = Math.min(this.cursorCol, cols);
    this.#touch();
  }

  reset(): void {
    this.grid = this.#blankGrid();
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.beeps = 0;
    this.#decoder.reset();
    this.#touch();
  }

  /** Feed raw server output through this screen's own decoder. */
  writeBytes(bytes: Uint8Array | number[]): void {
    for (const op of this.#decoder.feed(bytes)) this.apply(op);
  }

  apply(op: Op3600): void {
    switch (op.op) {
      case "char":
        if (this.cursorCol < this.cols) {
          this.grid[this.cursorRow][this.cursorCol] = glyphFor(op.code);
        }
        this.cursorCol = Math.min(this.cursorCol + 1, this.cols);
        break;
      case "beep":
        this.beeps++;
        break;
      case "newline":
        this.cursorCol = 0;
        if (this.cursorRow >= this.rows - 1) {
          this.grid.shift();
          this.grid.push(this.#blankRow());
          this.cursorRow = this.rows - 1;
        } else {
          this.cursorRow++;
          this.grid[this.cursorRow] = this.#blankRow();
        }
        break;
      case "clear":
        this.grid = this.#blankGrid();
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      case "clearEow":
        this.#clearEol();
        for (let r = this.cursorRow + 1; r < this.rows; r++) {
          this.grid[r] = this.#blankRow();
        }
        break;
      case "clearEol":
        this.#clearEol();
        break;
      case "insertChars": {
        const row = this.grid[this.cursorRow];
        const at = Math.min(this.cursorCol, this.cols);
        const n = Math.min(op.n, this.cols - at);
        row.splice(at, 0, ...Array.from({ length: n }, () => " "));
        row.length = this.cols;
        break;
      }
      case "deleteChars": {
        const row = this.grid[this.cursorRow];
        const at = Math.min(this.cursorCol, this.cols);
        const n = Math.min(op.n, this.cols - at);
        row.splice(at, n);
        while (row.length < this.cols) row.push(" ");
        break;
      }
      case "move":
        this.cursorCol = Math.min(op.x, this.cols - 1);
        this.cursorRow = Math.min(op.y, this.rows - 1);
        break;
      case "unknown":
        this.unknownBytes.push(op.byte);
        return; // no visible change
    }
    this.#touch();
  }

  #clearEol(): void {
    const row = this.grid[this.cursorRow];
    for (let c = this.cursorCol; c < this.cols; c++) row[c] = " ";
  }

  /** Rows as strings, trailing blanks trimmed. */
  lines(): string[] {
    return this.grid.map((r) => r.join("").replace(/\s+$/, ""));
  }

  /** The whole screen, trailing blank rows dropped. */
  text(): string {
    const rows = this.lines();
    let end = rows.length;
    while (end > 0 && rows[end - 1] === "") end--;
    return rows.slice(0, end).join("\n");
  }
}

// ---------------------------------------------------------------------------
// ANSI sink: 3600 ops -> xterm escapes, for the interactive repl
// ---------------------------------------------------------------------------

/**
 * Returns a function that renders each op to `write` as xterm output.  The
 * terminal should have autowrap off (`ESC [?7l`) so that a character in the
 * last column does not wrap, matching the grid `Screen`.
 */
export function ansiSink(write: (s: string) => void): (op: Op3600) => void {
  return (op) => {
    switch (op.op) {
      case "char":
        write(glyphFor(op.code));
        break;
      case "beep":
        write("\x07");
        break;
      case "newline":
        write("\r\n\x1b[2K");
        break;
      case "clear":
        write("\x1b[H\x1b[2J");
        break;
      case "clearEow":
        write("\x1b[J");
        break;
      case "clearEol":
        write("\x1b[K");
        break;
      case "insertChars":
        if (op.n > 0) write(`\x1b[${op.n}@`);
        break;
      case "deleteChars":
        if (op.n > 0) write(`\x1b[${op.n}P`);
        break;
      case "move":
        write(`\x1b[${op.y + 1};${op.x + 1}H`);
        break;
      case "unknown":
        break;
    }
  };
}

// ---------------------------------------------------------------------------
// Input encoding
// ---------------------------------------------------------------------------

export const BITS = { control: 1, meta: 2, super: 4, hyper: 8 } as const;

/** Logout: lead byte 0. */
export const LOGOUT: readonly number[] = [0];

/**
 * Genera character codes of the named keys (Genera 9.0, read live with
 * CHAR-CODE).  Names match Genera's key labels.
 */
export const KEY_CODES: Readonly<Record<string, number>> = {
  Space: 32,
  Suspend: 129,
  "Clear-Input": 130,
  Function: 132,
  Help: 134,
  Rubout: 135,
  Backspace: 136,
  Tab: 137,
  Line: 138,
  Refresh: 139,
  Page: 140,
  Return: 141,
  Abort: 145,
  Resume: 146,
  End: 148,
  Square: 149,
  Circle: 150,
  Triangle: 151,
  Scroll: 154,
  Select: 157,
  Network: 158,
  Escape: 159,
  Complete: 160,
  "Symbol-Help": 161,
};

const KEY_LOOKUP = new Map<string, number>(
  Object.entries(KEY_CODES).map(([k, v]) => [normalizeName(k), v]),
);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, "-");
}

/** The named keys, for help text. */
export function keyNames(): string[] {
  return Object.keys(KEY_CODES);
}

/** `[3, bits, code]`: one Genera character. */
export function encodeChar(code: number, bits = 0): number[] {
  return [3, bits & 0xff, code & 0xff];
}

/** `[1, cols, rows]`, each clamped to 1..255. */
export function encodeSize(cols: number, rows: number): number[] {
  const clamp = (n: number) => Math.max(1, Math.min(255, Math.floor(n)));
  return [1, clamp(cols), clamp(rows)];
}

/** Genera code for one text character, or undefined. */
function textCode(ch: string): number | undefined {
  const c = ch.codePointAt(0)!;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (ch === "\n" || ch === "\r") return KEY_CODES.Return;
  if (ch === "\t") return KEY_CODES.Tab;
  if (ch === "\b") return KEY_CODES.Backspace;
  if (ch === "\x7f") return KEY_CODES.Rubout;
  return GLYPH_TO_CODE.get(ch);
}

/**
 * Encode text as unmodified characters.  Printable ASCII maps to itself,
 * `\n`, `\r` and `\r\n` to Return, `\t` to Tab, `\b` to Backspace, DEL to
 * Rubout, and the SAIL glyphs back to 0..037 (and ∫ to 0177).  Throws on a
 * character Genera has no code for.
 */
export function encodeText(str: string): number[] {
  const out: number[] = [];
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\r" && chars[i + 1] === "\n") continue; // CRLF = one Return
    const code = textCode(ch);
    if (code === undefined) {
      throw new Error(
        `cannot type ${JSON.stringify(ch)} (U+${
          ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
        }): no Genera character code`,
      );
    }
    out.push(...encodeChar(code));
  }
  return out;
}

const PREFIX_RE = /^(sh|c|m|s|h)-(.+)$/i;

/**
 * Parse a key spec such as `c-m-Abort`, `m-X`, `Help`, `c-sh-a`, `a`.
 *
 * Prefixes `c-` `m-` `s-` `h-` set the control/meta/super/hyper bits; `sh-`
 * shifts a letter.  The key is a name from KEY_CODES (case-insensitive) or a
 * single character.  With any modifier bit an unshifted letter is sent as
 * its uppercase code and a shifted one as lowercase (Genera: `c-a` has code
 * 65, `c-sh-a` 97).  Without bits, `sh-a` is just `A`.
 */
export function parseKey(spec: string): number[] {
  let rest = spec;
  let bits = 0;
  let shift = false;
  for (let m = PREFIX_RE.exec(rest); m; m = PREFIX_RE.exec(rest)) {
    const p = m[1].toLowerCase();
    if (p === "c") bits |= BITS.control;
    else if (p === "m") bits |= BITS.meta;
    else if (p === "s") bits |= BITS.super;
    else if (p === "h") bits |= BITS.hyper;
    else shift = true;
    rest = m[2];
  }

  let code: number | undefined;
  const chars = [...rest];
  if (chars.length === 1) {
    const ch = chars[0];
    if (/^[a-z]$/i.test(ch)) {
      const lower = ch.toLowerCase();
      // With bits: unshifted -> uppercase code; shifted -> lowercase code.
      // Without bits: the letter as given, or uppercase if shifted.
      if (bits) code = (shift ? lower : lower.toUpperCase()).charCodeAt(0);
      else code = (shift ? ch.toUpperCase() : ch).charCodeAt(0);
      shift = false;
    } else {
      code = textCode(ch);
    }
  } else {
    code = KEY_LOOKUP.get(normalizeName(rest));
  }
  if (code === undefined) {
    throw new Error(
      `unknown key ${JSON.stringify(spec)}; use a single character or one of: ${
        keyNames().join(", ")
      }`,
    );
  }
  if (shift) {
    throw new Error(`key ${JSON.stringify(spec)}: sh- applies only to letters`);
  }
  return encodeChar(code, bits);
}
