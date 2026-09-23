#!/usr/bin/env -S deno test
/**
 * Tests for genera-3600.ts, the 3600-LOGIN codec (no network).
 *
 *   deno test unix-remote/genera-3600.test.ts
 */

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}
function assertThrows(fn: () => unknown, needle = ""): void {
  try {
    fn();
  } catch (e) {
    if (needle && !String(e).includes(needle)) {
      throw new Error(`threw ${e}, expected it to mention ${needle}`);
    }
    return;
  }
  throw new Error("expected an exception");
}

import {
  ansiSink,
  Decoder3600,
  encodeChar,
  encodeSize,
  encodeText,
  keyNames,
  LOGOUT,
  type Op3600,
  parseKey,
  SAIL_GLYPHS,
  Screen,
} from "./genera-3600.ts";

const bytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (h: string) =>
  Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

Deno.test("decoder: every op", () => {
  const ops = new Decoder3600().feed([
    0x41,
    0o200,
    0o201,
    0o202,
    0o203,
    0o204,
    0o205,
    3,
    0o206,
    4,
    0o207,
    10,
    20,
    0o377,
  ]);
  assertEquals<Op3600[]>(ops, [
    { op: "char", code: 0x41 },
    { op: "beep" },
    { op: "newline" },
    { op: "clear" },
    { op: "clearEow" },
    { op: "clearEol" },
    { op: "insertChars", n: 3 },
    { op: "deleteChars", n: 4 },
    { op: "move", x: 10, y: 20 },
    { op: "unknown", byte: 0o377 },
  ]);
});

Deno.test("decoder: op bytes as arguments are not ops", () => {
  const ops = new Decoder3600().feed([0o207, 0o201, 0o200, 0o205, 0o207]);
  assertEquals<Op3600[]>(ops, [
    { op: "move", x: 0o201, y: 0o200 },
    { op: "insertChars", n: 0o207 },
  ]);
});

Deno.test("decoder: state survives chunk splits", () => {
  const whole = [0x61, 0o207, 5, 6, 0o205, 2, 0o206, 1, 0x62];
  const expect = new Decoder3600().feed(whole);
  for (let cut = 0; cut <= whole.length; cut++) {
    const d = new Decoder3600();
    const got = [...d.feed(whole.slice(0, cut)), ...d.feed(whole.slice(cut))];
    assertEquals(got, expect, `split at ${cut}`);
  }
  // One byte at a time.
  const d = new Decoder3600();
  const got = whole.flatMap((b) => d.feed([b]));
  assertEquals(got, expect);
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

Deno.test("screen: chars, move is x then y, clamps", () => {
  const s = new Screen({ cols: 10, rows: 4 });
  s.writeBytes([0o207, 3, 1, ...bytes("hi")]);
  assertEquals(s.lines(), ["", "   hi", "", ""]);
  assertEquals([s.cursorRow, s.cursorCol], [1, 5]);
  s.writeBytes([0o207, 200, 200]);
  assertEquals([s.cursorRow, s.cursorCol], [3, 9]);
});

Deno.test("screen: SAIL glyphs and integral", () => {
  const s = new Screen({ cols: 40, rows: 2 });
  s.writeBytes([...Array.from({ length: 32 }, (_, i) => i), 0o177]);
  assertEquals(s.lines()[0], SAIL_GLYPHS.join("") + "∫");
  assertEquals(SAIL_GLYPHS.length, 32);
  assertEquals(SAIL_GLYPHS[0o10], "λ");
});

Deno.test("screen: newline goes to col 0 of next row and clears it", () => {
  const s = new Screen({ cols: 10, rows: 3 });
  s.writeBytes([0o207, 0, 1, ...bytes("stale"), 0o207, 4, 0, ...bytes("ab")]);
  s.writeBytes([0o201, ...bytes("x")]);
  assertEquals(s.lines(), ["    ab", "x", ""]);
  assertEquals([s.cursorRow, s.cursorCol], [1, 1]);
});

Deno.test("screen: newline on last row scrolls up", () => {
  const s = new Screen({ cols: 5, rows: 2 });
  s.writeBytes([...bytes("a"), 0o201, ...bytes("b"), 0o201, ...bytes("c")]);
  assertEquals(s.lines(), ["b", "c"]);
  assertEquals([s.cursorRow, s.cursorCol], [1, 1]);
});

Deno.test("screen: clear homes, clearEow, clearEol", () => {
  const s = new Screen({ cols: 5, rows: 3 });
  const fill = [0o207, 0, 0, ...bytes("aaaaa"), 0o207, 0, 1, ...bytes("bbbbb")]
    .concat([0o207, 0, 2, ...bytes("ccccc")]);
  s.writeBytes([...fill, 0o207, 2, 1, 0o204]);
  assertEquals(s.lines(), ["aaaaa", "bb", "ccccc"]);
  s.writeBytes([...fill, 0o207, 2, 1, 0o203]);
  assertEquals(s.lines(), ["aaaaa", "bb", ""]);
  s.writeBytes([0o202]);
  assertEquals(s.text(), "");
  assertEquals([s.cursorRow, s.cursorCol], [0, 0]);
});

Deno.test("screen: insert and delete chars", () => {
  const s = new Screen({ cols: 6, rows: 1 });
  s.writeBytes([...bytes("abcdef"), 0o207, 1, 0, 0o205, 2]);
  assertEquals(s.lines(), ["a  bcd"]);
  s.writeBytes([0o206, 3]);
  assertEquals(s.lines(), ["acd"]);
  assertEquals(s.cursorCol, 1);
});

Deno.test("screen: chars past the right edge are dropped", () => {
  const s = new Screen({ cols: 3, rows: 2 });
  s.writeBytes(bytes("abcdef"));
  assertEquals(s.lines(), ["abc", ""]);
  assertEquals(s.cursorCol, 3);
});

Deno.test("screen: unknown bytes logged, beep counted, version bumps", () => {
  const s = new Screen({ cols: 4, rows: 2 });
  const v0 = s.version;
  s.writeBytes([0o210, 0o377]);
  assertEquals(s.unknownBytes, [0o210, 0o377]);
  assertEquals(s.version, v0);
  s.writeBytes([0o200]);
  assertEquals(s.beeps, 1);
  s.writeBytes(bytes("x"));
  assert(s.version > v0);
});

Deno.test("screen: resize keeps content, reset clears", () => {
  const s = new Screen({ cols: 4, rows: 2 });
  s.writeBytes([...bytes("abcd"), 0o201, ...bytes("ef")]);
  s.resize(2, 3);
  assertEquals(s.lines(), ["ab", "ef", ""]);
  assertEquals([s.cols, s.rows], [2, 3]);
  s.writeBytes([0o207]); // half an op, then reset
  s.reset();
  s.writeBytes(bytes("z"));
  assertEquals(s.lines(), ["z", "", ""]);
});

/**
 * Captured live from Genera 9.0.8 on 2026-09-23: connect to 3600-LOGIN,
 * send only encodeSize(80, 24), collect 5 s.  Note the herald's line
 * continuation: "!" printed in column 78, a move back to (78,1), newline.
 */
const LIVE_HERALD =
  "8253796d626f6c6963732053797374656d2c20583a2f55736572732f6c646265" +
  "74682f5075626c69632f73796d626f6c6963732f696e697469616c2e766c6f64" +
  "815669727475616c204c697370204d616368696e652050726f636573736f722c" +
  "20343039352e304d20776f726473207669727475616c206d656d6f7279207265" +
  "717565737465642c20343037382e3321874e01814d20776f726473207374696c" +
  "6c20617661696c61626c652e812047656e657261870903392e302e388146696e" +
  "616c652045746865726e616c81813e20";

Deno.test("screen: live 3600-LOGIN herald capture renders", () => {
  const s = new Screen({ cols: 80, rows: 24 });
  s.writeBytes(hex(LIVE_HERALD));
  assertEquals(s.unknownBytes, []);
  assertEquals(
    s.text(),
    [
      "Symbolics System, X:/Users/ldbeth/Public/symbolics/initial.vlod",
      "Virtual Lisp Machine Processor, 4095.0M words virtual memory requested, 4078.3!",
      "M words still available.",
      " Genera  9.0.8",
      "Finale Ethernal",
      "",
      ">",
    ].join("\n"),
  );
  assertEquals([s.cursorRow, s.cursorCol], [6, 2]);
});

// ---------------------------------------------------------------------------
// ANSI sink
// ---------------------------------------------------------------------------

Deno.test("ansiSink: ops to xterm escapes", () => {
  let out = "";
  const sink = ansiSink((s) => out += s);
  for (const op of new Decoder3600().feed([
    0x41,
    2,
    0o200,
    0o201,
    0o202,
    0o203,
    0o204,
    0o205,
    3,
    0o206,
    0,
    0o207,
    4,
    9,
    0o300,
  ])) sink(op);
  assertEquals(
    out,
    "Aα\x07\r\n\x1b[2K\x1b[H\x1b[2J\x1b[J\x1b[K\x1b[3@\x1b[10;5H",
  );
});

// ---------------------------------------------------------------------------
// Input encoding
// ---------------------------------------------------------------------------

Deno.test("parseKey: modifiers, letters, named keys", () => {
  assertEquals(parseKey("c-a"), [3, 1, 65]);
  assertEquals(parseKey("c-sh-a"), [3, 1, 97]);
  assertEquals(parseKey("m-X"), [3, 2, 88]);
  assertEquals(parseKey("m-x"), [3, 2, 88]);
  assertEquals(parseKey("c-m-Abort"), [3, 3, 145]);
  assertEquals(parseKey("Help"), [3, 0, 134]);
  assertEquals(parseKey("help"), [3, 0, 134]);
  assertEquals(parseKey("a"), [3, 0, 97]);
  assertEquals(parseKey("A"), [3, 0, 65]);
  assertEquals(parseKey("sh-a"), [3, 0, 65]);
  assertEquals(parseKey("s-h-Select"), [3, 12, 157]);
  assertEquals(parseKey("h"), [3, 0, 104]);
  assertEquals(parseKey("c--"), [3, 1, 45]);
  assertEquals(parseKey("Clear Input"), [3, 0, 130]);
  assertEquals(parseKey("Symbol-Help"), [3, 0, 161]);
  assertEquals(parseKey("λ"), [3, 0, 8]);
});

Deno.test("parseKey: errors", () => {
  assertThrows(() => parseKey("Frobnicate"), "unknown key");
  assertThrows(() => parseKey("c-"), "unknown key");
  assertThrows(() => parseKey("sh-Help"), "sh-");
});

Deno.test("keyNames lists the named keys", () => {
  const names = keyNames();
  for (const k of ["Help", "Abort", "Select", "Function", "Return"]) {
    assert(names.includes(k), k);
  }
});

Deno.test("encodeText", () => {
  assertEquals(encodeText("a B"), [3, 0, 97, 3, 0, 32, 3, 0, 66]);
  assertEquals(encodeText("x\ny\r\nz\r"), [
    ...encodeChar(120),
    ...encodeChar(141),
    ...encodeChar(121),
    ...encodeChar(141),
    ...encodeChar(122),
    ...encodeChar(141),
  ]);
  assertEquals(encodeText("\t\b\x7f"), [3, 0, 137, 3, 0, 136, 3, 0, 135]);
  assertEquals(encodeText("λ→∫"), [3, 0, 8, 3, 0, 25, 3, 0, 0o177]);
  assertThrows(() => encodeText("“"), "U+201C");
});

Deno.test("encodeSize and LOGOUT", () => {
  assertEquals(encodeSize(80, 24), [1, 80, 24]);
  assertEquals(encodeSize(300, 0), [1, 255, 1]);
  assertEquals([...LOGOUT], [0]);
});
