#!/usr/bin/env -S deno test --allow-net
/**
 * Tests for supdup.ts: the pure codecs, plus one socket round trip against
 * an in-process fake of Genera's SUPDUP server (no real VLM needed).
 *
 *   deno test --allow-net unix-remote/supdup.test.ts
 */

// Minimal assertion helpers — kept local so the suite pulls no deps.
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

import {
  decodeOptionBlock,
  encodeKeys,
  encodeOptionBlock,
  KeyEncoder,
  LOGOUT,
  runSession,
  SupdupDecoder,
  TD,
  TTYOPT_LEFT,
  TTYOPT_RIGHT,
} from "./supdup.ts";

const E = "\x1b";
const u8 = (...b: number[]) => new Uint8Array(b);
const bytes = (r: { bytes: Uint8Array }) => Array.from(r.bytes);
const C = (ch: string) => ch.charCodeAt(0);

// ===========================================================================
// Option block
// ===========================================================================

Deno.test("option block: -count header and 6-bit packing", () => {
  const b = encodeOptionBlock({ rows: 24, cols: 80 });
  assertEquals(b.length, 6 + 8 * 6);
  // Header: left half = 2^18 - 8 = 0777770 -> 77 77 70; right half 0.
  assertEquals(Array.from(b.subarray(0, 6)), [0o77, 0o77, 0o70, 0, 0, 0]);
  for (const x of b) assert(x < 0o100, "every byte is 6 bits");
  // Word 1 = TTYOPT: left 0410413 -> 41 04 13; right 040 -> 00 00 40.
  assertEquals(TTYOPT_LEFT, 0o410413);
  assertEquals(Array.from(b.subarray(12, 18)), [0o41, 0o04, 0o13, 0, 0, 0o40]);
  // HEIGHT 24 = 030, WIDTH 80 = 0120 -> 01 20.
  assertEquals(Array.from(b.subarray(18, 24)), [0, 0, 0, 0, 0, 0o30]);
  assertEquals(Array.from(b.subarray(24, 30)), [0, 0, 0, 0, 0o01, 0o20]);
  // Round trip through the Genera-style reader.
  const d = decodeOptionBlock(b)!;
  assertEquals(d.length, b.length);
  assertEquals(d.words, [
    [0, 7],
    [TTYOPT_LEFT, TTYOPT_RIGHT],
    [0, 24],
    [0, 80],
    [0, 1],
    [0, 0],
    [0, 9600],
    [0, 9600],
  ]);
  assertEquals(decodeOptionBlock(b.subarray(0, 20)), null);
});

Deno.test("option block: forbidden TTYOPT bits are clear", () => {
  assertEquals(TTYOPT_LEFT & 0o1000, 0, "%TOOVR");
  assertEquals(TTYOPT_LEFT & 0o4000, 0, "%TOSAI");
  assertEquals(TTYOPT_RIGHT & 0o4, 0, "%TPRSC");
});

// ===========================================================================
// Output decoder
// ===========================================================================

function dec(...chunks: number[][]): string {
  const d = new SupdupDecoder();
  return chunks.map((c) => d.feed(new Uint8Array(c))).join("");
}

Deno.test("decoder: printable, pass-through and dropped controls", () => {
  assertEquals(
    dec([C("H"), C("i"), 0o15, 0o12, 7, 8, 9, 0, 1, 0o33, 0o177]),
    "Hi\r\n\x07\b\t",
  );
});

Deno.test("decoder: zero-argument %TD codes", () => {
  const cases: [number, string][] = [
    [TD.EOF, `${E}[J`],
    [TD.EOL, `${E}[K`],
    [TD.DLF, `${E}[X`],
    [TD.CRL, `\r\n${E}[K`],
    [TD.NOP, ""],
    [TD.BS, "\b"],
    [TD.LF, `${E}[B`],
    [TD.RCR, "\r"],
    [TD.FS, `${E}[C`],
    [TD.CLR, `${E}[H${E}[2J`],
    [TD.BEL, "\x07"],
    [0o201, ""],
    [0o377, ""],
  ];
  for (const [code, want] of cases) {
    assertEquals(dec([code]), want, `code 0${code.toString(8)}`);
  }
});

Deno.test("decoder: argument codes", () => {
  assertEquals(dec([TD.MV0, 3, 5]), `${E}[4;6H`);
  assertEquals(dec([TD.MOV, 1, 2, 10, 20]), `${E}[11;21H`);
  assertEquals(dec([TD.ILP, 2]), `${E}[2L`);
  assertEquals(dec([TD.DLP, 3]), `${E}[3M`);
  assertEquals(dec([TD.ICP, 4]), `${E}[4@`);
  assertEquals(dec([TD.DCP, 5]), `${E}[5P`);
  assertEquals(dec([TD.ILP, 0]), "");
  assertEquals(dec([TD.RSU, 10, 2, C("x")]), "x");
  assertEquals(dec([TD.RSD, 10, 2, C("y")]), "y");
  assertEquals(dec([TD.QOT, C("A")]), "A");
  assertEquals(dec([TD.QOT, TD.CLR, C("z")]), "z", "quoted %TD is literal");
  // An argument byte that looks like a %TD code is still an argument.
  assertEquals(dec([TD.MV0, 0o203, 0o220]), `${E}[132;145H`);
});

Deno.test("decoder: arguments split across chunks", () => {
  assertEquals(dec([C("a"), TD.MV0], [3], [5, C("b")]), `a${E}[4;6Hb`);
  assertEquals(dec([TD.MOV, 1], [2, 3], [], [4]), `${E}[4;5H`);
  assertEquals(dec([TD.DLP], [7]), `${E}[7M`);
  assertEquals(dec([TD.QOT], [C("Q")]), "Q");
});

// ===========================================================================
// Key encoder
// ===========================================================================

const k = (s: string) => bytes(encodeKeys(s));

Deno.test("keys: plain and raw specials", () => {
  assertEquals(k("ab Z"), [C("a"), C("b"), 32, C("Z")]);
  assertEquals(k("\r"), [0o15]);
  assertEquals(k("\t"), [0o11]);
  assertEquals(k("\x7f"), [0o177]);
  assertEquals(k("\b"), [0o10]);
  assertEquals(k("é"), [], "UTF-8 dropped (0303 would be a SUPDUP escape)");
});

Deno.test("keys: control letters send uppercase with the control bit", () => {
  assertEquals(k("\x01"), [0o34, 0o101, C("A")]); // c-a
  assertEquals(k("\x0c"), [0o34, 0o101, C("L")], "Ctrl-L not raw Refresh");
  assertEquals(k("\x1a"), [0o34, 0o101, C("Z")], "Ctrl-Z not raw Abort");
  assertEquals(k("\x1c"), [0o34, 0o34], "Ctrl-\\ doubled");
});

Deno.test("keys: ESC prefix is Meta; lone ESC is Escape", () => {
  assertEquals(k("\x1bx"), [0o34, 0o102, C("X")]); // m-x
  assertEquals(k("\x1bX"), [0o34, 0o102, C("x")]); // m-sh-x
  assertEquals(k("\x1b\x06"), [0o34, 0o103, C("F")]); // c-m-f
  assertEquals(k("\x1b<"), [0o34, 0o102, C("<")]);
  assertEquals(k("\x1b"), [0o33]);
  // Lone ESC in one read, x in the next: Escape then x.
  const enc = new KeyEncoder();
  assertEquals(bytes(enc.feed(u8(0o33))), [0o33]);
  assertEquals(bytes(enc.feed(u8(C("x")))), [C("x")]);
});

Deno.test("keys: arrows, Home/End/PgUp/PgDn, function keys", () => {
  assertEquals(k(`${E}[A`), [0o34, 0o101, C("P")]);
  assertEquals(k(`${E}[B`), [0o34, 0o101, C("N")]);
  assertEquals(k(`${E}[C`), [0o34, 0o101, C("F")]);
  assertEquals(k(`${E}[D`), [0o34, 0o101, C("B")]);
  assertEquals(k(`${E}OA`), [0o34, 0o101, C("P")], "SS3 arrow");
  assertEquals(k(`${E}[H`), [0o34, 0o102, C("<")]);
  assertEquals(k(`${E}[F`), [0o34, 0o120, C("e")]);
  assertEquals(k(`${E}[5~`), [0o34, 0o102, C("V")]);
  assertEquals(k(`${E}[6~`), [0o34, 0o101, C("V")]);
  assertEquals(k(`${E}OP`), [0o34, 0o120, C("H")], "F1 Help");
  assertEquals(k(`${E}OQ`), [0o34, 0o120, C("B")], "F2 Suspend");
  assertEquals(k(`${E}OR`), [0o34, 0o101, C("H")], "F3 Resume");
  assertEquals(k(`${E}OS`), [0o34, 0o120, C("a")], "F4 Abort");
  assertEquals(k(`${E}[15~`), [0o14], "F5 Refresh");
  assertEquals(k(`${E}[17~`), [0o34, 0o120, C("C")], "F6 Clear-Input");
  assertEquals(k(`${E}[18~`), [0o34, 0o120, C("A")], "F7 Function");
  assertEquals(k(`${E}[19~`), [0o34, 0o120, C("e")], "F8 End");
  assertEquals(k(`${E}[20~`), [0o34, 0o120, C("n")], "F9 Network");
  assertEquals(k(`${E}[1;5A`), [0o34, 0o101, C("P")], "modifier ignored");
  assertEquals(k(`${E}[3~`), [], "unknown sequence ignored");
  assertEquals(k(`${E}[99zq`), [C("q")], "unknown final ignored, rest kept");
});

Deno.test("keys: Ctrl-] escape menu", () => {
  const menu = (c: string) => encodeKeys("\x1d" + c);
  assertEquals(bytes(menu("h")), [0o34, 0o120, C("H")]);
  assertEquals(bytes(menu("a")), [0o34, 0o120, C("a")]);
  assertEquals(bytes(menu("e")), [0o34, 0o120, C("e")]);
  assertEquals(bytes(menu("s")), [0o34, 0o120, C("B")]);
  assertEquals(bytes(menu("r")), [0o34, 0o101, C("H")]);
  assertEquals(bytes(menu("c")), [0o34, 0o120, C("C")]);
  assertEquals(bytes(menu("f")), [0o34, 0o120, C("A")]);
  assertEquals(bytes(menu("n")), [0o34, 0o120, C("n")]);
  assertEquals(bytes(menu("l")), [0o14]);
  assertEquals(bytes(menu("\x1d")), [0o34, 0o101, C("]")]);
  assertEquals(bytes(menu("z")), [], "unknown menu key does nothing");
  const help = menu("?");
  assert(help.help && !help.quit);
  assertEquals(bytes(help), []);
  const q = menu("qxyz");
  assert(q.quit);
  assertEquals(bytes(q), LOGOUT, "quit stops encoding the rest");
  // Menu key in a later read than the Ctrl-].
  const enc = new KeyEncoder();
  assertEquals(bytes(enc.feed(u8(0x1d))), []);
  assertEquals(bytes(enc.feed(u8(C("a")))), [0o34, 0o120, C("a")]);
  assertEquals(bytes(enc.feed(u8(C("a")))), [C("a")], "menu is one-shot");
});

// ===========================================================================
// Socket round trip against a fake Genera SUPDUP server
// ===========================================================================

async function readAtLeast(
  conn: Deno.Conn,
  have: Uint8Array,
  n: number,
): Promise<Uint8Array> {
  let buf = have;
  while (buf.length < n) {
    const tmp = new Uint8Array(256);
    const r = await conn.read(tmp);
    if (r === null) throw new Error("fake server: client closed early");
    const nb = new Uint8Array(buf.length + r);
    nb.set(buf);
    nb.set(tmp.subarray(0, r), buf.length);
    buf = nb;
  }
  return buf;
}

/** Fake server: greeting, parse option block, then run `script`. */
function fakeServer(
  script: (
    conn: Deno.Conn,
    words: [number, number][],
    rest: Uint8Array,
  ) => Promise<void>,
): { port: number; done: Promise<void> } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const done = (async () => {
    const conn = await listener.accept();
    listener.close();
    try {
      const greet = new TextEncoder().encode("FAKE-GENERA\r\n");
      await conn.write(new Uint8Array([...greet, TD.NOP]));
      const buf = await readAtLeast(conn, new Uint8Array(0), 6 + 8 * 6);
      const opts = decodeOptionBlock(buf);
      assert(opts, "complete option block");
      await script(conn, opts.words, buf.subarray(opts.length));
    } finally {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  })();
  return { port, done };
}

Deno.test("socket: option block reaches the server; output renders", async () => {
  let seen: [number, number][] = [];
  const srv = fakeServer(async (conn, words) => {
    seen = words;
    // Split %TDMV0's arguments across writes to exercise chunk state.
    await conn.write(u8(TD.CLR, TD.MV0, 3));
    await new Promise((r) => setTimeout(r, 20));
    await conn.write(u8(5, C("H"), C("i"), TD.EOL));
  });
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: srv.port });
  let screen = "";
  const how = await runSession({
    net: conn,
    keys: null,
    write: (s) => {
      screen += s;
    },
    note: () => {},
    rows: 30,
    cols: 100,
  });
  await srv.done;
  try {
    conn.close();
  } catch { /* closed by session */ }
  assertEquals(how, "closed");
  assertEquals(seen[1], [TTYOPT_LEFT, TTYOPT_RIGHT], "TTYOPT");
  assertEquals(seen[2], [0, 30], "HEIGHT");
  assertEquals(seen[3], [0, 100], "WIDTH");
  assertEquals(screen, `FAKE-GENERA\r\n${E}[H${E}[2J${E}[4;6HHi${E}[K`);
});

Deno.test("socket: Ctrl-] q sends logout and ends the session", async () => {
  let got: number[] = [];
  const srv = fakeServer(async (conn, _w, rest) => {
    const buf = await readAtLeast(conn, rest, 3);
    got = Array.from(buf);
    // Genera would now THROW NETWORK-TERMINAL-EXIT and close.
  });
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: srv.port });
  const keys = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x"));
      c.enqueue(u8(0x1d, C("q")));
    },
  });
  let noted = "";
  const how = await runSession({
    net: conn,
    keys,
    write: () => {},
    note: (s) => {
      noted += s;
    },
    rows: 24,
    cols: 80,
  });
  await srv.done;
  try {
    conn.close();
  } catch { /* closed by session */ }
  assertEquals(how, "quit");
  assertEquals(got, [C("x"), ...LOGOUT]);
  assertEquals(noted, "");
});
