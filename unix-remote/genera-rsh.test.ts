#!/usr/bin/env -S deno test --allow-net
/**
 * Tests for genera-rsh.ts: the pure wrapper/parsers, and a socket
 * round-trip against an in-test fake of Genera's UNIX-REXEC-SERVER
 * (sys.sct/embedding/ux/unix-protocols.lisp).  No real VLM needed.
 *
 *   deno test --allow-net unix-remote/genera-rsh.test.ts
 */

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
      `expected ${JSON.stringify(haystack)} to include ${
        JSON.stringify(needle)
      }`,
    );
  }
}

import {
  buildEvalWrapper,
  evalForm,
  makeNonce,
  parseCommandReply,
  parseEvalReply,
  parseRshReply,
  rejectionHint,
  rshExec,
  rshRequest,
  runCommand,
} from "./genera-rsh.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const N = "RSH0123456789abcdef";

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

Deno.test("rshRequest: four NUL-terminated strings", () => {
  assertEquals(
    new TextDecoder().decode(rshRequest("(+ 1 2)", "me")),
    "0\0me\0me\0(+ 1 2)\0",
  );
  let threw = false;
  try {
    rshRequest("(print \"λ\")");
  } catch (e) {
    threw = String(e).includes("U+3BB");
  }
  assert(threw, "expected an 8-bit-only error");
});

Deno.test("makeNonce is alphanumeric and fresh", () => {
  const a = makeNonce(), b = makeNonce();
  assert(/^[A-Za-z0-9]+$/.test(a), a);
  assert(a !== b);
});

Deno.test("buildEvalWrapper", () => {
  assertEquals(
    buildEvalWrapper("(+ 1 2)", N),
    `(conditions:handler-case (cl:let ((v (cl:multiple-value-list (+ 1 2)))) ` +
      `(cl:format cl:t "${N}V~{~S${N}~}~%" v)) ` +
      `(cl:error (e) (cl:format cl:t "${N}E~A~%" e)))`,
  );
});

Deno.test("parseRshReply: lead byte", () => {
  assertEquals(parseRshReply(enc("\0\n3 ")), { status: "ok", output: "\n3 " });
  assertEquals(parseRshReply(enc("\x01nope\n")), {
    status: "rejected",
    output: "nope\n",
  });
  assertEquals(parseRshReply(new Uint8Array()).status, "rejected");
  assertEquals(parseRshReply(enc("\0par"), true), {
    status: "timeout",
    output: "par",
  });
});

Deno.test("parseEvalReply: values", () => {
  assertEquals(
    parseEvalReply({ status: "ok", output: `${N}V3${N}\n` }, N),
    { output: "", values: ["3"] },
  );
  // Output before the marker; a value with a space and a newline.
  assertEquals(
    parseEvalReply(
      { status: "ok", output: `\n1 ${N}V2${N}"a b\nc"${N}\n` },
      N,
    ),
    { output: "\n1 ", values: ["2", `"a b\nc"`] },
  );
  assertEquals(parseEvalReply({ status: "ok", output: `${N}V\n` }, N), {
    output: "",
    values: [],
  });
});

Deno.test("parseEvalReply: error", () => {
  assertEquals(
    parseEvalReply({ status: "ok", output: `x${N}EThe first argument...\n` }, N),
    { output: "x", error: "The first argument..." },
  );
  // No marker: the server's own handler caught it.
  assertEquals(
    parseEvalReply({ status: "ok", output: "Something broke\n" }, N),
    { output: "", error: "Something broke" },
  );
});

Deno.test("parseEvalReply: \\1 read error and rejection hint", () => {
  const r = parseEvalReply(
    { status: "rejected", output: "End of file occurred while reading\n" },
    N,
  );
  assertEquals(r, { output: "", error: "End of file occurred while reading" });
  const busy = parseEvalReply(
    { status: "rejected", output: "This machine is in use by LDBETH\n" },
    N,
  );
  assertStringIncludes(busy.error!, "This machine is in use by LDBETH");
  assertStringIncludes(busy.error!, "NET:EVAL-SERVER-ON");
  assertEquals(rejectionHint("Host is not authorized"), "");
});

Deno.test("parseEvalReply / parseCommandReply: timeout", () => {
  const t = parseEvalReply({ status: "timeout", output: "partial" }, N);
  assertEquals(t, { output: "partial", timedOut: true, error: "timed out" });
  assertEquals(parseCommandReply({ status: "ok", output: "herald\n" }), {
    output: "herald\n",
  });
  assertEquals(parseCommandReply({ status: "timeout", output: "h" }), {
    output: "h",
    timedOut: true,
    error: "timed out",
  });
});

// ---------------------------------------------------------------------------
// Socket round-trip against a fake rsh server
// ---------------------------------------------------------------------------

/** Parse the four C-strings, then reply with handler(command) bytes. */
function fakeRsh(handler: (cmd: string, fields: string[]) => string | null) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const requests: string[][] = [];
  const serve = (async () => {
    for await (const conn of listener) {
      (async () => {
        const got: number[] = [];
        const buf = new Uint8Array(1024);
        let fields: string[] = [];
        while (true) {
          const n = await conn.read(buf);
          if (n === null) break;
          got.push(...buf.subarray(0, n));
          fields = new TextDecoder().decode(Uint8Array.from(got)).split("\0");
          if (fields.length >= 5) break; // four terminators seen
        }
        fields = fields.slice(0, 4);
        requests.push(fields);
        const reply = handler(fields[3], fields);
        if (reply !== null) {
          await conn.write(enc(reply));
          conn.close();
        } // null: hang, to exercise the client timeout
        else setTimeout(() => {
          try {
            conn.close();
          } catch { /* closed by client */ }
        }, 1000);
      })();
    }
  })();
  return {
    port,
    requests,
    async close() {
      listener.close();
      await serve.catch(() => {});
    },
  };
}

/** A tiny evaluator for the wrapped forms the tests send. */
function fakeEval(cmd: string): string | null {
  const m = /multiple-value-list (.*)\)\)\) \(cl:format cl:t "(RSH[0-9a-f]+)V/
    .exec(cmd);
  if (!m) {
    if (cmd === "Show Herald") return "\0\nGenera 9.0.8\n";
    if (cmd === "busy") return "\x01This machine is in use by LDBETH\n";
    return "\x01End of file occurred while reading\n";
  }
  const [, form, n] = m;
  if (form === "(+ 1 2)") return `\0${n}V3${n}\n`;
  if (form === "(progn (print 1) (values 2 3))") {
    return `\0\n1 ${n}V2${n}3${n}\n`;
  }
  if (form === "(car 5)") return `\0${n}EThe first argument to CAR...\n`;
  if (form === "(loop)") return null;
  return `\0${n}V${n}\n`;
}

Deno.test("socket round-trip against a fake rsh server", async () => {
  const srv = fakeRsh(fakeEval);
  try {
    const H = "127.0.0.1", P = srv.port;
    assertEquals(await evalForm(H, P, "(+ 1 2)", { timeoutMs: 2000 }), {
      output: "",
      values: ["3"],
    });
    assertEquals(
      await evalForm(H, P, "(progn (print 1) (values 2 3))", {
        timeoutMs: 2000,
      }),
      { output: "\n1 ", values: ["2", "3"] },
    );
    assertEquals(await evalForm(H, P, "(car 5)", { timeoutMs: 2000 }), {
      output: "",
      error: "The first argument to CAR...",
    });
    assertEquals(await runCommand(H, P, "Show Herald", { timeoutMs: 2000 }), {
      output: "\nGenera 9.0.8\n",
    });
    const busy = await runCommand(H, P, "busy", { timeoutMs: 2000 });
    assertStringIncludes(busy.error!, "NET:EVAL-SERVER-ON");
    const raw = await rshExec(H, P, "(+ 1", { timeoutMs: 2000, user: "me" });
    assertEquals(raw.status, "rejected");
    assertEquals(srv.requests.at(-1), ["0", "me", "me", "(+ 1"]);

    const t0 = Date.now();
    const hung = await evalForm(H, P, "(loop)", { timeoutMs: 200 });
    assert(hung.timedOut === true, JSON.stringify(hung));
    assert(Date.now() - t0 < 900, "timeout took too long");
  } finally {
    await srv.close();
  }
});
