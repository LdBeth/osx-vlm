# unix-remote — host-side helpers for the Genera VLM

Tools that run on the macOS host to provide Unix-side services the VLM expects
over the network:

  * `rmtd` — fake tape server (rexec + BSD `rmt`); see below.
  * `tapedump` — inspect a `.tap` tape image.
  * `org.pkgsrc.telnetd.plist` — launchd job for a host telnet server.
  * `lpdd` — LPD print server that spools each hardcopy to a file; see below.
  * `org.genera.lpdd.plist` — launchd job for `lpdd`.
  * `psfix` — repairs font encodings (and optionally page order) in spooled Genera PostScript; see below.
  * `genera-remote.ts` — telnet client + screen model that drives the Genera
    Lisp Listener, exposed as an MCP server and a CLI; see below.

## Tape server (`rmtd`)

The VLM has no tape driver. Genera reaches a tape by opening a BSD `rexec`
connection (TCP **512**) to a host carrying the `(:TAPE :TCP :UNIX-REXEC)`
service, running `/usr/sbin/rmt`, and speaking the BSD remote-magtape (`rmt`)
protocol. (Sources: `sys.sct/embedding/ux/{unix-protocols,unix-tape}.lisp`.)

`rmtd` is a single process that impersonates all of it — rexecd + `/etc/rmt` +
the drive. The "tape" is a regular file in **SIMH `.tap`** format, so filemarks
and multi-file tapes work and images interchange with other tools.

## Run

    sudo ./rmtd --tape /path/to/genera.tap        # port 512 needs root
    ./rmtd --tape test.tap --port 1512 -vv        # high port for testing; -vv traces wire

A missing tape image is created empty. Serves one connection at a time
(a single drive). `-v` traces commands, `-vv` adds replies.

## Genera namespace setup (important)

Register the server's host object with **Machine Type `DEC-AXP`** — *not* Sun.
DEC-AXP selects the only rmt dialect that both:

  * never issues the binary `S` (status) command — which would need a real
    `struct mtget`, and
  * sets `allow-short-input-records-p` true, so a real per-record tape isn't
    mistaken for EOF on the first short read.

Add the `(:TAPE :TCP :UNIX-REXEC)` service to that host and set
`tape:*default-tape-host*` to it. The username/password Genera prompts for are
ignored by `rmtd`.

**Device name must be `mt<unit><density>`** (e.g. `mt0h`), NOT `Cart`. Under the
DEC-AXP dialect Genera strictly parses the device string (`unix-tape.lisp:301`):
it must start with `mt`, a unit number 0–31, and end in a density letter
`a`/`l`/`m`/`h`. Anything else (like `Cart`) errors with "Invalid device name".
`rmtd` ignores the name, so unit/density are cosmetic — they just have to parse.

## Inspecting a tape image

`tapedump` shows the physical structure of a `.tap` file (the bytes inside
records are Genera's own formats and aren't decoded):

    ./tapedump genera.tap            # summary: files, record counts, sizes
    ./tapedump genera.tap -v         # list every record with an ascii preview
    ./tapedump genera.tap -x         # full hex+ascii of each record
    ./tapedump genera.tap -f 1 -o f  # extract file 1's raw record data to ./f

To read the *logical* content, use Genera's own commands against the live
tape: `Show Tape Directory`, `Restore Distribution`, `Restore File`, etc.

## What's implemented

rexec handshake; rmt `O`pen/`C`lose/`R`ead/`W`rite/`L`seek; MTIOCTOP
`WEOF/FSF/BSF/FSR/BSR/REW/OFFL/EOM/ERASE/NOP/RETEN`. Reverse-skip is
best-effort (Genera flags it unsupported for this stream). Writing truncates
the image past the write point, matching tape semantics.

## .tap format

`<u32 len LE> <len bytes> [pad to even] <u32 len LE>` per record; `0x00000000`
= filemark; `0xFFFFFFFF` = end of medium.

# Telnet server (`org.pkgsrc.telnetd.plist`)

macOS ships no telnet client *or* `telnetd`. Get both from pkgsrc GNU
**inetutils**, which g-prefixes its binaries (`/opt/pkg/libexec/gtelnetd`,
client `/opt/pkg/bin/gtelnet`):

    sudo /opt/pkg/bin/pkgin install inetutils

macOS has no `inetd` either, so the supplied **launchd** job runs `gtelnetd` in
inetd-compatibility mode: `launchd` holds the listening socket and hands each
accepted connection to `gtelnetd` on stdin, which execs macOS `login(1)`.

Key bits of the plist:

  * `--exec-login=/usr/bin/login` — use macOS `login`. (Beware: in GNU
    `telnetd`, `-l` is *linemode*, not login; the login flag is `-E`.)
  * `SockServiceName telnet` → port **23** (via `/etc/services`).
  * `SockNodeName 192.168.2.1` — the macOS host's address on the **vmnet
    bridge** (guest = `192.168.2.2`, host/gateway = `192.168.2.1`, per
    `og2vlm/.VLM`). The guest reaches the Mac there, the same path `rmtd` uses.
    Do **not** bind `127.0.0.1` — the guest can't reach the Mac's loopback.

Install and start (the bridge address `192.168.2.1` only exists **while the VLM
is running**, so bootstrap with the VLM up or the bind fails with no listener):

    sudo install -o root -g wheel -m 644 org.pkgsrc.telnetd.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/org.pkgsrc.telnetd.plist
    netstat -an -p tcp | grep '\.23 .*LISTEN'      # expect 192.168.2.1.23 ... LISTEN

Reload after editing the plist (re-copy first — the live job runs the copy in
`/Library/LaunchDaemons`):

    sudo launchctl bootout system/org.pkgsrc.telnetd
    sudo install -o root -g wheel -m 644 org.pkgsrc.telnetd.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/org.pkgsrc.telnetd.plist

Then from Genera: `telnet 192.168.2.1` reaches the macOS `login:` prompt.

Troubleshooting: nothing on `:23` + `launchctl print system/org.pkgsrc.telnetd`
saying *"Could not find service"* means the job isn't loaded — bootstrap it.
A malformed `SockNodeName` (e.g. a stray `=192.168.2.1`) makes `launchd` bind
nothing and register no socket; fix the address and re-bootstrap. **Security:**
telnet is plaintext — keep it bound to the bridge IP, never `0.0.0.0`.

# LPD print-to-file server (`lpdd`)

Genera hardcopies over **LPD/LPR (TCP 515)**. We don't want a real printer —
just to capture the PostScript Genera's LGP2 driver emits. macOS ships no
`lpd`, and its CUPS no longer supports raw queues or `file://` capture (Apple
keeps gutting CUPS), so `lpdd` stands in. Like `rmtd` impersonates a tape, it
impersonates `lpd`: it speaks just enough of RFC 1179 to accept a "receive job"
and write the data file to a spool directory.

    Genera (LGP2/PostScript) --LPD:515--> lpdd --> /Users/ldbeth/genera-spool/*.ps

One file per job (no overwrite). The name is built from the LPD control file —
`genera-<date>-<seq>-<jobname>.ps` — and the extension is sniffed (`.ps` if the
data starts with `%!`, else `.txt`). Both LPD data framings are handled: a
fixed byte count, and count-0 / stream-to-EOF.

## Run

    sudo ./lpdd --spool /Users/ldbeth/genera-spool          # port 515 needs root
    ./lpdd --spool /tmp/spool --port 1515 -v                # high port, no root
    ./lpdd --spool /Users/ldbeth/genera-spool --inetd       # one conn on stdin

`--wait` retries the bind until `--host` exists — the vmnet bridge
`192.168.2.1` only comes up while the VLM runs. `-v` logs jobs, `-vv` is debug.

## launchd job (`org.genera.lpdd.plist`)

A long-running server (NOT `inetdCompatibility`): `launchd` keeps it alive with
`KeepAlive`, and `lpdd --wait` handles the listen and rides the bridge coming up
and going down. So — unlike telnetd — you can bootstrap it with the VLM **down**;
it just waits. Logs to `/Users/ldbeth/genera-spool/lpdd.log`.

    sudo install -o root -g wheel -m 644 org.genera.lpdd.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/org.genera.lpdd.plist
    netstat -an -p tcp | grep '\.515 .*LISTEN'     # 192.168.2.1.515 LISTEN once VLM is up

Reload after editing (re-copy first — the live job runs the copy in
`/Library/LaunchDaemons`):

    sudo launchctl bootout system/org.genera.lpdd
    sudo install -o root -g wheel -m 644 org.genera.lpdd.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/org.genera.lpdd.plist

## Genera namespace

Register a Printer object of a PostScript-capable Type (`LGP2`) whose
**Interface** reaches the Mac over LPR:

    Interface  :LGP   Host <mac-host>  Protocol :LPR  Queue "genera"

The queue name is cosmetic — `lpdd` spools every job regardless. Make it the
default:

    Set Printer <name>
    ;; or
    (setq hardcopy:*default-text-printer* (net:find-object-named :printer "<name>"))

Print anything (`Hardcopy File`, or a screen hardcopy). The PostScript lands in
the spool dir; open it in Preview to confirm.

## Notes / gotchas

  * Nothing captured → run `lpdd` in the foreground with `-vv` and watch the
    handshake; check `lpdd.log` under the launchd job. The bridge IP only exists
    while the VLM runs, so with `--wait` the listener appears only then.
  * `lpdd` does no filtering — the file is byte-for-byte what Genera sent, ideal
    for archiving or distilling to PDF. For a real printer, pipe the spooled
    `.ps` onward (`lp`, `pstopdf`, etc.) or point Genera at a CUPS queue instead.
  * **Security:** LPD is unauthenticated — keep it bound to `192.168.2.1`,
    never `0.0.0.0`.
  * `psfix` is a stdin/stdout filter (not run inside `lpdd`) that repairs two
    modern-font encoding mismatches in captured Genera PostScript — it blanks
    the stray `#\Return` (code 141) and restores the two Symbol glyphs modern
    fonts drop (183/190). Run it over a capture before distilling to PDF:

        ./psfix < ~/genera-spool/genera-....ps > fixed.ps

  * Page order is now a Lisp-side setting, not a filter concern: give the
    printer's namespace object a `Default-Print-Backwards NIL` User Property
    (Namespace Editor → the printer → add User Property) and Open Genera's LGP2
    driver spools pages ascending instead of its last-first default. Only for a
    capture taken before that was set (or a printer still spooling last-first)
    do you need `psfix --reorder`, which reverses the pages safely despite the
    driver's incremental glyph download. Without `--reorder` the page order is
    left untouched.

# Listener driver (`genera-remote.ts`)

Where `rmtd`/`lpdd` impersonate Unix services the guest *dials out* to,
`genera-remote.ts` goes the other way: it **telnets into** the guest's Lisp
Listener and drives it programmatically. It renders Genera's X3.64/ANSI output
into an in-memory screen grid and exposes read/type/wait/eval verbs — as an
**MCP server** (for Claude Code and other MCP clients) and as a plain **CLI**.

One Deno file, no `package.json`. The telnet client and screen model are
dependency-free; only the MCP layer reaches for `npm:@modelcontextprotocol/sdk`
(pinned to `1.29.0`, loaded from the local Deno npm cache via a `npm:`
specifier and imported lazily, so `deno test` and the CLI never touch it).

## Run

    # MCP stdio server (default when no verb) — this is what Claude Code spawns
    ./genera-remote.ts                    # connects on demand via genera_connect

    # CLI: each verb connects, acts, disconnects (fresh Listener each time)
    ./genera-remote.ts screen                         # print the screen
    ./genera-remote.ts eval '(+ 1 2)'                 # eval a form, print output
    ./genera-remote.ts type 'Show Herald'             # type literal text
    ./genera-remote.ts key Abort                      # press a named key
    ./genera-remote.ts wait --pattern 'Command: '     # wait for the prompt
    ./genera-remote.ts keys                           # list the key table
    ./genera-remote.ts repl                           # interactive, stays connected

    # target + output
    --host H   default 192.168.2.2 (the guest on the vmnet bridge; env GENERA_HOST)
    --port N   default 23                             (env GENERA_PORT)
    --json     machine-readable output where applicable

The shebang is `deno run --allow-net --allow-env --allow-read`. `--allow-net`
is for the telnet socket; `--allow-env` reads `GENERA_HOST`/`GENERA_PORT`;
`--allow-read` lets the MCP SDK resolve itself from the Deno cache. The MCP
server additionally needs `--allow-run` *only if* a client spawns it such that
it re-execs Deno — the default stdio path does not, so the three flags above
suffice. (The test suite uses `--allow-run` because it spawns the server as a
child; see Testing.)

`repl` holds one login open: blank line = Return, a Lisp form is typed and
submitted, `/screen` reprints, `/key NAME` presses a key, `/wait` settles,
`/quit` exits.

### Per-invocation login

Each CLI verb (except `repl`) opens a fresh telnet connection, and Genera's
telnet server drops a trusted client **straight into a Lisp Listener with no
username/password step** (`net:remote-login-on` gates it; the herald prints,
then `SI:LISP-TOP-LEVEL1` runs — `network/network-terminal.lisp:161-205`). So
per-command reconnect is cheap and needs no credential handling — it just
means Listener state (variables, history) does not persist between commands.
Use `repl`, or the MCP server's persistent session, when you need continuity.

## MCP tools

Registered on the stdio server (`McpServer` + `StdioServerTransport`):

  * `genera_connect {host?, port?}` / `genera_disconnect`
  * `genera_screen` → the character grid as text + cursor + connection state
  * `genera_type {text}` → literal text, no newline appended
  * `genera_key {name}` → a named Genera key (see the table below)
  * `genera_wait {pattern?, stable_ms?, timeout_ms?}` → returns when a regex
    appears **or** the screen is unchanged for `stable_ms`; always returns the
    final screen; fails closed (error flag) on timeout. Stability is measured
    from the moment the call begins, so an in-flight repaint always gets a
    chance to land before the screen is declared settled.
  * `genera_eval {form, timeout_ms?}` → types the form + Return, waits for the
    next prompt, and returns **exactly** the text the Listener printed in
    between (the echoed form and the trailing prompt are stripped).
  * `genera_log {limit?}` → the in-memory action log

Every tool result carries an `action` entry (ISO timestamp, intent, outcome),
the current `state`, and (for most) the `screen` — so a caller always knows
where the session stands. The session also keeps a rolling action log
retrievable via `genera_log`.

### Registering with Claude Code

Add to a project `.mcp.json` (this repo does **not** commit one):

```json
{
  "mcpServers": {
    "genera": {
      "command": "deno",
      "args": [
        "run", "--allow-net", "--allow-env", "--allow-read",
        "/Users/ldbeth/Public/Projects/linux-vlm/unix-remote/genera-remote.ts"
      ],
      "env": { "GENERA_HOST": "192.168.2.2", "GENERA_PORT": "23" }
    }
  }
}
```

## Terminal / key mapping — the one real unknown (now known)

This mapping was reverse-engineered from the Genera 8.5 server sources
(`network/network-terminal.lisp`, `network/remote-terminal.lisp`). The
surprising part: **Genera's telnet server negotiates almost nothing.**

  * **No TTYPE, no NAWS, no SGA.** On connect the server sends exactly one
    thing — `IAC WILL ECHO` (`FF FB 01`, `network-terminal.lisp:255-258`) — and
    then *silently ignores* every `DO`/`WILL`/`WONT`/`DONT` and every `SB` for
    everything else (`network-terminal.lisp:286-296`). The only IAC it acts on
    besides `IAC IAC` is `IAC DO LOGOUT`, which closes the connection. So there
    is **no terminal-type negotiation on the wire** — a client's `WILL TTYPE` /
    `WILL NAWS` / `DO SGA` go unanswered. `genera-remote.ts` offers them anyway
    (harmless, and meaningful against the test server), but treats them as
    best-effort and never blocks on a reply.
  * **X3.64 is set out of band, not by TTYPE.** The `:TELNET` login server
    starts in *printing* (glass-TTY) mode assuming a non-display terminal
    (`network-terminal.lisp:321-322`); the `X3.64` flag defaults `NIL`
    (`remote-terminal.lisp:1179`). A user turns cursor addressing on **after
    login** with the CP command `Set Remote Terminal Options` → answer *yes* to
    “Console supports X3.64 display codes” (`remote-terminal.lisp:1444-1445`).
    The known-good `:x3.64` from the interactive recipe is *gtelnet's* own
    emulator setting, not something the server reads. **Practical upshot:**
    `genera_eval`/`genera_type`/`genera_screen` work fine in printing mode
    (the Listener prints plain text with CR/LF either way); only full-screen
    cursor addressing needs X3.64, so send
    `type ":Set Remote Terminal Options"` + Return and confirm if you need it
    (or bake the default into the world). Without NAWS, the server's own
    `WIDTH` (default 79) / `HEIGHT` govern layout, also set via that command.

### Keys the server understands (from the client)

Two layers process each input byte: `CONVERT-ASCII-TO-LISPM`
(`remote-terminal.lisp:1015-1034`) maps control codes, and
`ASCII-TERMINAL-FILTER` + the `SPECIAL-KEYS` table
(`remote-terminal.lisp:1048-1065`) handle the escape-prefix scheme. A special
key is the prefix **`c-_` (0x1F)** followed by a letter (case-insensitive on
the server). `genera-remote.ts` implements the full table (`./genera-remote.ts
keys`):

| Genera key | Bytes | Source |
|---|---|---|
| Return | `0D` | CR → `#\RETURN` |
| Line | `0A` | LF → `#\LINE` (or `c-_ L`) |
| Tab | `09` | HT → `#\TAB` |
| Rubout | `7F` | DEL → `#\RUBOUT` (verified interactively) |
| Abort | `1F 41` | `c-_ A` — the interrupt char (there is **no** telnet-IP path) |
| Suspend | `1F 53` | `c-_ S` |
| Resume | `1F 52` | `c-_ R` |
| Clear-Input | `1F 49` | `c-_ I` |
| End | `1F 45` | `c-_ E` |
| Complete | `1F 43` | `c-_ C` |
| Help | `1F 48` | `c-_ H` |
| Page | `1F 50` | `c-_ P` |
| Refresh | `1F 46` | `c-_ F` |
| Escape (key) | `1F 58` | `c-_ X` (bare `1B` is the **Meta** prefix, not Escape) |
| Backspace | `1F 42` | `c-_ B` — **bare `08` maps to End**, not Backspace |
| Network | `1F 4E` | `c-_ N` |
| Square/Circle/Triangle | `1F 31`/`32`/`33` | `c-_ 1`/`2`/`3` |

Modifier prefixes toggle a Bucky bit for the **next** character:
Meta `1B`, Control `1E`, Super `1D`, Hyper `1C`, Shift `00`
(`remote-terminal.lisp:1041-1046`) — so `key Control` then `type "a"` yields
Control-A. Genera's **`#\FUNCTION` and `#\SELECT` keys have no byte sequence**
in the server's table and are deliberately absent. Client-side CSI/arrow
sequences are **not** decoded by the server (a bare `ESC` is eaten as the Meta
toggle), so there is no way to send an arrow key over this path.

### Output the server emits (what the screen model parses)

To an X3.64 terminal Genera emits, all via `ESC [` CSI
(`remote-terminal.lisp:1263-1340`): CUP (`H`), HPA (`` ` ``), VPA (`d`),
CUF (`C`), reverse-index (`ESC M`), ED (`J`), EL (`K`), ECH (`X`), ICH (`@`),
DCH (`P`), IL (`L`), DL (`M`), SGR (`m`), plus raw CR/LF/BS/TAB/BEL. It never
emits a scrolling-region (DECSTBM) sequence and never relies on auto-wrap
(it addresses within `WIDTH-1` and wraps manually). The screen model
implements this repertoire; anything unrecognised is logged to
`unknownSequences` and ignored — a mis-parse never crashes a live session.

### The prompt

The Listener's default (command-preferred) prompt is the literal string
`Command: ` at the start of a fresh line (`cp/defs.lisp:59,85-87`); there is no
numbered `>` prompt on this path. `genera_eval` detects it to know a form has
finished. (In form-only mode the prompt is empty — set the mode back to
command-preferred if eval's prompt detection matters.)

## Testing

A fake Genera telnet server (`genera-remote-test.ts`) stands in for the VLM
(which needs sudo to boot): it speaks the same negotiation, paints a herald
with X3.64 sequences, echoes typed characters, and answers a small canned set
of forms. The suite covers the negotiation transcript, screen-model rendering
(golden screens as plain text), wait semantics, eval output extraction, the
key table, and — over the **real** MCP SDK transport — the handshake plus a
`tools/call` round trip:

    deno test --allow-net --allow-env --allow-read --allow-run unix-remote/

`--allow-run` is needed because the MCP round-trip test spawns the server as a
child process; the other flags mirror the driver's own. The SDK must already
be in the Deno npm cache (it is; the tests run fully offline). As of the last
run: **23 passed, 0 failed** (`deno test` exit 0), `deno lint` and `deno check`
clean.

You can also drive the fake server by hand:

    ./genera-remote-test.ts --port 2323 &
    ./genera-remote.ts eval '(* 6 7)' --host 127.0.0.1 --port 2323   # -> 42

## Live verification (against the real VLM)

Once the VLM is booted (it binds `192.168.2.2:23` while running):

  1. `./genera-remote.ts screen` — expect the Symbolics herald and, on a fresh
     login, a `Command: ` prompt. If instead you see “Type :Set Remote Terminal
     Options to set the terminal type”, you are in printing mode (fine for
     eval; see below for X3.64).
  2. `./genera-remote.ts eval '(+ 1 2)'` — expect `3`. Try
     `'(lisp-implementation-version)'` and `'(machine-type)'`.
  3. `./genera-remote.ts key Abort` after starting something — expect it to
     interrupt back to a `Command: ` prompt (this exercises `c-_ A`, the one
     path that reaches `#\ABORT`; telnet IP does nothing).
  4. For full-screen apps: `./genera-remote.ts repl`, then type
     `:Set Remote Terminal Options`, confirm X3.64, and run e.g.
     `Show Directory` — the screen model should track cursor addressing.
  5. Register the MCP server (snippet above) and, from Claude Code, call
     `genera_connect` then `genera_eval` — confirm the JSON result carries the
     output, the screen, and an action-log entry.

## Security

Plain telnet, no TLS, no auth beyond Genera's namespace trust. Like the
`telnetd`/`lpdd` notes above: this only ever talks to the **bridge addresses**
(`192.168.2.2` guest / `192.168.2.1` host), which exist only while the VLM
runs. Never expose it on `0.0.0.0` or a routable interface — a trusted-host
telnet login to Genera is an unauthenticated Lisp Listener, i.e. full control
of the world. The driver connects out to a host you name; it never listens.
