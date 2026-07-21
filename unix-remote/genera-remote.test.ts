#!/usr/bin/env -S deno test --allow-net --allow-env --allow-read
/**
 * Tests for genera-remote.ts, run against the fake server in
 * genera-remote-test.ts (no real VLM needed).
 *
 *   deno test --allow-net --allow-env --allow-read unix-remote/
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
        JSON.stringify(haystack.slice(0, 200))
      }`,
    );
  }
}

import {
  DEFAULT_PROMPT_PATTERN,
  GeneraSession,
  keyNames,
  lookupKey,
  Screen,
  TelnetClient,
} from "./genera-remote.ts";

import { FAKE_PROMPT, FakeGeneraServer } from "./genera-remote-test.ts";

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

// ===========================================================================
// Screen model — pure, no network
// ===========================================================================

Deno.test("screen: plain text and wrapping", () => {
  const s = new Screen({ cols: 10, rows: 4 });
  s.write("hello");
  assertEquals(s.lines()[0], "hello");
  assertEquals(s.cursorRow, 0);
  assertEquals(s.cursorCol, 5);
  // Deferred wrap: 10 chars fill the row, the 11th wraps.
  s.reset();
  s.write("0123456789X");
  assertEquals(s.grid[0].join(""), "0123456789");
  assertEquals(s.lines()[1], "X");
  assertEquals(s.cursorRow, 1);
});

Deno.test("screen: CUP cursor addressing", () => {
  const s = new Screen({ cols: 20, rows: 5 });
  s.write("\x1b[3;5Hhi");
  assertEquals(s.cursorRow, 2); // row 3, 0-indexed
  assertEquals(s.grid[2].slice(4, 6).join(""), "hi");
});

Deno.test("screen: erase line and display", () => {
  const s = new Screen({ cols: 10, rows: 3 });
  s.write("AAAAAAAAAA");
  s.write("\x1b[1;1H"); // home
  s.write("\x1b[0K"); // erase to end of line
  assertEquals(s.lines()[0], "");
  s.reset();
  s.write("row0\r\n\x1b[2;1Hrow1\x1b[1;1H\x1b[2J");
  assertEquals(s.text().trim(), "");
});

Deno.test("screen: CR/LF and scrolling into scrollback", () => {
  const s = new Screen({ cols: 8, rows: 2 });
  s.write("aaa\r\nbbb\r\nccc");
  // Two rows visible; the first scrolled into scrollback.
  assertEquals(s.scrollback.length, 1);
  assertEquals(s.scrollback[0], "aaa");
  assertEquals(s.lines(), ["bbb", "ccc"]);
  assertEquals(s.transcript(), ["aaa", "bbb", "ccc"]);
});

Deno.test("screen: unknown sequence is logged, not fatal", () => {
  const s = new Screen({ cols: 10, rows: 2 });
  s.write("\x1b[99ZX"); // Z is not a final we implement
  assert(s.unknownSequences.length >= 1);
  assertStringIncludes(s.unknownSequences[0], "Z");
  assertEquals(s.grid[0][0], "X"); // parsing recovered
});

Deno.test("screen: DSR cursor-position reply", () => {
  const replies: string[] = [];
  const s = new Screen({ cols: 20, rows: 5, onReply: (t) => replies.push(t) });
  s.write("\x1b[2;3H\x1b[6n");
  assertEquals(replies, ["\x1b[2;3R"]);
});

Deno.test("screen: scroll region (DECSTBM) keeps top rows", () => {
  const s = new Screen({ cols: 6, rows: 4 });
  s.write("top\r\n");
  s.write("\x1b[2;4r"); // scroll region rows 2..4
  s.write("\x1b[2;1H"); // into the region
  s.write("a\r\nb\r\nc\r\nd"); // forces a scroll inside the region
  assertEquals(s.lines()[0], "top"); // untouched by the region scroll
  assertEquals(s.scrollback.length, 0); // region scroll doesn't feed scrollback
});

// ===========================================================================
// Telnet negotiation
// ===========================================================================

Deno.test("telnet: negotiation transcript and x3.64 selection", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const screen = new Screen();
    const tn = new TelnetClient({ onData: (b) => screen.writeBytes(b) });
    await tn.connect(server.hostname, server.port);
    await waitFor(() => server.sessions[0]?.terminalType === "x3.64");

    const sess = server.sessions[0];
    assertEquals(sess.terminalType, "x3.64");
    assertEquals(sess.naws, { cols: 80, rows: 24 });
    assert(tn.serverEchoes, "server should have offered ECHO and we accept");
    assert(tn.nawsAccepted, "server accepted our NAWS");
    assertEquals(tn.negotiatedTerminalType, "x3.64");

    // Client answered TTYPE SEND with IS x3.64.
    assert(
      tn.negotiationLog.includes("SEND SB TTYPE IS x3.64"),
      tn.negotiationLog.join(","),
    );
    tn.close();
  } finally {
    server.close();
  }
});

Deno.test("telnet: escaped IAC byte in data is delivered once", () => {
  const got: number[] = [];
  const tn = new TelnetClient({ onData: (b) => got.push(...b) });
  // IAC IAC = one literal 0xFF; surrounded by ordinary bytes.
  tn.feed(new Uint8Array([65, 255, 255, 66]));
  assertEquals(got, [65, 255, 66]);
});

Deno.test("telnet: refuses unsupported DO with WONT", () => {
  const log: string[] = [];
  const tn = new TelnetClient({
    onData: () => {},
    onNegotiation: (l) => log.push(l),
  });
  // Server asks us to DO LINEMODE(34), which we do not support.
  tn.feed(new Uint8Array([255, 253, 34]));
  assert(log.includes("SEND WONT LINEMODE"), log.join(","));
});

Deno.test("telnet: NAWS refused path leaves nawsAccepted false", async () => {
  const server = new FakeGeneraServer({ refuseNaws: true });
  server.listen();
  try {
    const screen = new Screen();
    const tn = new TelnetClient({ onData: (b) => screen.writeBytes(b) });
    await tn.connect(server.hostname, server.port);
    await waitFor(() => server.sessions[0]?.terminalType === "x3.64");
    assertEquals(tn.nawsAccepted, false);
    tn.close();
  } finally {
    server.close();
  }
});

// ===========================================================================
// Session: herald, wait, eval
// ===========================================================================

Deno.test("session: herald renders as a golden screen", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    await s.wait({ stableMs: 300, timeoutMs: 3000 });
    const golden = [
      "Symbolics Virtual Lisp Machine",
      "Genera 8.5",
      "",
      "Command:",
    ].join("\n");
    assertEquals(s.screen.text(), golden);
    assert(s.atPrompt(), "cursor should be at the Command: prompt");
    s.disconnect();
  } finally {
    server.close();
  }
});

Deno.test("session: prompt pattern matches Genera-style prompts", () => {
  const re = DEFAULT_PROMPT_PATTERN;
  assert(re.test("Command: "));
  assert(re.test("Eval: "));
  assert(re.test("Some Frame > "));
  assert(re.test("USER: Lisp>"));
  assert(!re.test("Command: (+ 1 2)"), "an unfinished form is not a prompt");
  assert(!re.test("loading..."));
});

Deno.test("session: eval extracts exactly the printed output", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    await s.wait({ stableMs: 300, timeoutMs: 3000 });

    const r1 = await s.evalForm("(+ 1 2)", 5000);
    assertEquals(r1.timedOut, false);
    assertEquals(r1.output, "3");

    const r2 = await s.evalForm("(machine-type)", 5000);
    assertEquals(r2.output, '"Symbolics Virtual Lisp Machine"');
    s.disconnect();
  } finally {
    server.close();
  }
});

Deno.test("session: wait matches a pattern", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    const r = await s.wait({ pattern: "Genera 8\\.5", timeoutMs: 3000 });
    assert(r.matched);
    assert(!r.timedOut);
    s.disconnect();
  } finally {
    server.close();
  }
});

Deno.test("session: wait fails closed on timeout", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    await s.wait({ stableMs: 300, timeoutMs: 3000 });
    const r = await s.wait({ pattern: "NEVER_APPEARS", timeoutMs: 300 });
    assert(r.timedOut);
    assert(!r.matched);
    s.disconnect();
  } finally {
    server.close();
  }
});

Deno.test("session: type before connect throws", () => {
  const s = new GeneraSession();
  let threw = false;
  try {
    s.type("hi");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("session: action log records intent and outcome", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    await s.wait({ stableMs: 200, timeoutMs: 3000 });
    s.type("x");
    assert(s.actionLog.length >= 2);
    const last = s.actionLog[s.actionLog.length - 1];
    assert("time" in last && "intent" in last && "outcome" in last);
    s.disconnect();
  } finally {
    server.close();
  }
});

// ===========================================================================
// Key map
// ===========================================================================

Deno.test("keymap: core keys resolve to bytes", () => {
  for (const name of ["Return", "Line", "Rubout"]) {
    const d = lookupKey(name);
    assert(d, `key ${name} must exist`);
    assert(d!.bytes.length >= 1);
    assert(d!.note.length > 0, `key ${name} must document its provenance`);
  }
  assertEquals(lookupKey("Return")!.bytes, [0x0d]);
  assertEquals(lookupKey("Rubout")!.bytes, [0x7f]);
  // Case-insensitive.
  assert(lookupKey("rubout"));
  assert(lookupKey("RUBOUT"));
});

Deno.test("keymap: special keys use the c-_ prefix", () => {
  // c-_ = 0x1F; letter is the SPECIAL-KEYS entry.
  assertEquals(lookupKey("Abort")!.bytes, [0x1f, 0x41]);
  assertEquals(lookupKey("Clear-Input")!.bytes, [0x1f, 0x49]);
  assertEquals(lookupKey("End")!.bytes, [0x1f, 0x45]);
  // Real Backspace needs the escape; a bare 0x08 would mean End.
  assertEquals(lookupKey("Backspace")!.bytes, [0x1f, 0x42]);
  // Function/Select have no server mapping and must not be present.
  assertEquals(lookupKey("Function"), null);
  assertEquals(lookupKey("Select"), null);
});

Deno.test("keymap: unknown key returns null and is not listed", () => {
  assertEquals(lookupKey("NotAKey"), null);
  assert(!keyNames().includes("NotAKey"));
});

Deno.test("session: key sends the mapped bytes", async () => {
  const server = new FakeGeneraServer();
  server.listen();
  try {
    const s = new GeneraSession({ host: server.hostname, port: server.port });
    await s.connect();
    await s.wait({ stableMs: 200, timeoutMs: 3000 });
    s.type("ab");
    await s.wait({ stableMs: 200, timeoutMs: 2000 });
    s.key("Rubout");
    await s.wait({ stableMs: 200, timeoutMs: 2000 });
    const sess = server.sessions[0];
    // Last input byte should be DEL (0x7f).
    assertEquals(sess.input[sess.input.length - 1], 0x7f);
    s.disconnect();
  } finally {
    server.close();
  }
});

// ===========================================================================
// MCP: real SDK transport, one round trip
// ===========================================================================

Deno.test({
  name: "mcp: handshake and a tools/call round trip",
  // Spawns a child Deno running the MCP server; needs run permission, and the
  // SDK must already be in the npm cache (offline).
  permissions: { net: true, env: true, read: true, run: true },
  async fn() {
    // Start a fake Genera the MCP server can connect to.
    const server = new FakeGeneraServer();
    server.listen();

    const { Client } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/index.js"
    );
    const { StdioClientTransport } = await import(
      "npm:@modelcontextprotocol/sdk@1.29.0/client/stdio.js"
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
      env: { GENERA_HOST: server.hostname, GENERA_PORT: String(server.port) },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = (tools.tools as Array<{ name: string }>).map((t) => t.name)
        .sort();
      for (
        const expected of [
          "genera_connect",
          "genera_disconnect",
          "genera_eval",
          "genera_key",
          "genera_log",
          "genera_screen",
          "genera_type",
          "genera_wait",
        ]
      ) {
        assert(
          names.includes(expected),
          `missing tool ${expected} in ${names.join(",")}`,
        );
      }

      const connectRes = await client.callTool({
        name: "genera_connect",
        arguments: {},
      });
      const connectText =
        (connectRes.content as Array<{ type: string; text: string }>)[0].text;
      assertStringIncludes(connectText, "Symbolics Virtual Lisp Machine");

      const evalRes = await client.callTool({
        name: "genera_eval",
        arguments: { form: "(* 6 7)" },
      });
      const evalText =
        (evalRes.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(evalText);
      assertEquals(parsed.output, "42");
    } finally {
      await client.close();
      server.close();
    }
  },
});

// Keep a reference so the linter doesn't flag the imported constant as unused
// in case a future edit drops its only use.
export const _fakePrompt = FAKE_PROMPT;
