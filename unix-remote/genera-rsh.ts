/**
 * genera-rsh — evaluate forms and run CP commands on Genera over rsh (TCP 514).
 *
 * Server side reference (read-only), rel-9-0 tree:
 *   sys.sct/embedding/ux/unix-protocols.lisp — (:SERVER-TOP-LEVEL
 *   UNIX-REXEC-SERVER), which serves both :UNIX-REXEC (512) and :UNIX-RSH (514).
 *
 * Wire protocol, as that method reads it:
 *
 *   client: "<error-port>\0<user>\0<password>\0<command>\0"
 *           error-port "0" (or empty) = errors share the main stream.
 *           user and password are read and ignored.
 *   server: rejects with byte 1 + text + newline, then closes:
 *             - host not trusted ("Host is not authorized to use this protocol.")
 *             - NET:EVAL-SERVER-ON is NIL and someone is logged in
 *               ("This machine is in use by <user>")
 *             - the command text fails to parse (a read error)
 *           otherwise writes byte 0, EVALs the command-or-form (CP commands
 *           preferred) with *STANDARD-OUTPUT* etc. bound to the socket, and
 *           closes.  An error during EVAL is caught by the server and its
 *           report written as plain text after the 0: the reply alone cannot
 *           tell a value from an error, hence the wrapper in `evalForm`.
 *
 * Forms are read in CL-USER.  A client-side timeout only closes the socket;
 * a looping form keeps running in Genera.
 */

export const DEFAULT_RSH_PORT = 514;

export interface RshOptions {
  /** Sent as both user and password; the server ignores both. */
  user?: string;
  /** Client-side timeout; the socket is closed when it expires. */
  timeoutMs?: number;
}

export type RshStatus = "ok" | "rejected" | "timeout";

export interface RshReply {
  /** "ok": the server accepted (lead byte 0); "rejected": lead byte 1 or no
   *  reply at all; "timeout": closed by us before EOF. */
  status: RshStatus;
  /** Everything after the lead byte, decoded one byte per character. */
  output: string;
}

/**
 * The request bytes for one rsh command, one byte per character (the reply
 * is decoded the same way).  Throws on a character above U+00FF.
 */
export function rshRequest(command: string, user = "lispm"): Uint8Array {
  const s = "0\0" + user + "\0" + user + "\0" + command + "\0";
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) {
      throw new Error(
        `cannot send U+${c.toString(16).toUpperCase()} over rsh (8-bit only)`,
      );
    }
    out[i] = c;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
}

/** Split a raw reply into status and text. */
export function parseRshReply(bytes: Uint8Array, timedOut = false): RshReply {
  if (bytes.length === 0) {
    return {
      status: timedOut ? "timeout" : "rejected",
      output: timedOut ? "" : "(connection closed without a reply)",
    };
  }
  const lead = bytes[0];
  const output = latin1(bytes.subarray(lead === 0 || lead === 1 ? 1 : 0));
  if (timedOut) return { status: "timeout", output };
  return { status: lead === 1 ? "rejected" : "ok", output };
}

/** Send one command and read the reply to EOF (or timeout). */
export async function rshExec(
  host: string,
  port: number,
  command: string,
  opts: RshOptions = {},
): Promise<RshReply> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let conn: Deno.TcpConn;
  try {
    conn = await Deno.connect({ hostname: host, port, signal });
  } catch (e) {
    if (signal.aborted) return { status: "timeout", output: "" };
    throw e;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      conn.close();
    } catch { /* already closed */ }
  }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    await conn.write(rshRequest(command, opts.user));
    const buf = new Uint8Array(8192);
    while (true) {
      let n: number | null;
      try {
        n = await conn.read(buf);
      } catch (e) {
        if (timedOut) break;
        throw e;
      }
      if (n === null) break;
      chunks.push(buf.slice(0, n));
      total += n;
    }
  } finally {
    clearTimeout(timer);
    if (!timedOut) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return parseRshReply(all, timedOut);
}

/**
 * An explanation to append to a rejection, or "" if none applies.
 */
export function rejectionHint(text: string): string {
  if (/in use by/i.test(text)) {
    return "Genera's rsh server refuses evaluation while someone is logged " +
      "in unless NET:EVAL-SERVER-ON is set on the Genera side.";
  }
  return "";
}

function rejectionError(output: string): string {
  const text = output.trim() || "rejected";
  const hint = rejectionHint(text);
  return hint ? `${text}\n${hint}` : text;
}

// ---------------------------------------------------------------------------
// evalForm
// ---------------------------------------------------------------------------

export interface EvalResult {
  /** What the form printed, up to the result marker. */
  output: string;
  /** Printed (~S) values, one string per value; absent on error. */
  values?: string[];
  /** Error report; absent on success. */
  error?: string;
  /** True when the client gave up waiting. */
  timedOut?: boolean;
}

/** A fresh random marker, alphanumeric so it is inert in a FORMAT string. */
export function makeNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "RSH" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Wrap a form so its values and errors are marked in the output:
 *
 *   <nonce>V<v1><nonce><v2><nonce>...\n     on success (each ~S)
 *   <nonce>E<error report>\n               on an ERROR condition
 *
 * Each value is followed by the nonce, so values that print with spaces or
 * newlines still split unambiguously.
 */
export function buildEvalWrapper(form: string, nonce: string): string {
  return `(conditions:handler-case (cl:let ((v (cl:multiple-value-list ${form}))) ` +
    `(cl:format cl:t "${nonce}V~{~S${nonce}~}~%" v)) ` +
    `(cl:error (e) (cl:format cl:t "${nonce}E~A~%" e)))`;
}

function stripOneNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/** Interpret the reply to a wrapped form. */
export function parseEvalReply(reply: RshReply, nonce: string): EvalResult {
  if (reply.status === "rejected") {
    return { output: "", error: rejectionError(reply.output) };
  }
  const text = reply.output;
  const vAt = text.lastIndexOf(nonce + "V");
  const eAt = text.lastIndexOf(nonce + "E");
  const at = Math.max(vAt, eAt);
  if (at < 0) {
    // No marker: the server's own error handler replied, the form was
    // aborted, or we timed out.
    if (reply.status === "timeout") {
      return { output: text, timedOut: true, error: "timed out" };
    }
    return {
      output: "",
      error: text.trim() || "connection closed without a result",
    };
  }
  const output = text.slice(0, at);
  const body = text.slice(at + nonce.length + 1);
  const timedOut = reply.status === "timeout" ? { timedOut: true } : {};
  if (at === eAt) {
    return { output, error: stripOneNewline(body).trim(), ...timedOut };
  }
  const parts = body.split(nonce);
  parts.pop(); // the remainder after the last value: "\n"
  return { output, values: parts, ...timedOut };
}

/** Evaluate a Lisp form (read in CL-USER) and return output and values. */
export async function evalForm(
  host: string,
  port: number,
  form: string,
  opts: RshOptions = {},
): Promise<EvalResult> {
  const nonce = makeNonce();
  const reply = await rshExec(host, port, buildEvalWrapper(form, nonce), opts);
  return parseEvalReply(reply, nonce);
}

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

export interface CommandResult {
  output: string;
  /** Rejection text (with hint); absent when the server accepted. */
  error?: string;
  timedOut?: boolean;
}

/** Interpret the reply to a raw CP command. */
export function parseCommandReply(reply: RshReply): CommandResult {
  if (reply.status === "rejected") {
    return { output: "", error: rejectionError(reply.output) };
  }
  if (reply.status === "timeout") {
    return { output: reply.output, timedOut: true, error: "timed out" };
  }
  return { output: reply.output };
}

/**
 * Send CP command text (e.g. "Show Herald") as is.  Errors signalled by the
 * command come back as ordinary output (the server catches them after
 * accepting), so `error` is set only for rejections and timeouts.
 */
export async function runCommand(
  host: string,
  port: number,
  text: string,
  opts: RshOptions = {},
): Promise<CommandResult> {
  return parseCommandReply(await rshExec(host, port, text, opts));
}
