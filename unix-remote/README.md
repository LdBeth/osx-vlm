# unix-remote — host-side helpers for the Genera VLM

Tools that run on the macOS host to provide Unix-side services the VLM expects
over the network:

  * `rmtd` — fake tape server (rexec + BSD `rmt`); see below.
  * `tapedump` — inspect a `.tap` tape image.
  * `org.pkgsrc.telnetd.plist` — launchd job for a host telnet server.
  * `lpdd` — LPD print server that spools each hardcopy to a file; see below.
  * `org.genera.lpdd.plist` — launchd job for `lpdd`.
  * `psfix` — repairs font encodings (and optionally page order) in spooled Genera PostScript; see below.
  * `genera-remote.ts` — drives Genera over rsh (eval, CP commands) and its
    3600-LOGIN remote terminal, as an MCP server and a CLI; see below.
  * `supdup.ts` — interactive SUPDUP (RFC 734) terminal client for logging in
    to Genera on TCP 95; see below.

## Tape server (`rmtd`)

The VLM has no tape driver. Genera reaches a tape by opening a BSD `rexec`
connection (TCP **512**) to a host carrying the `(:TAPE :TCP :UNIX-REXEC)`
service, running `/etc/rmt` there, and speaking the BSD remote-magtape (`rmt`)
protocol. (Sources: `sys.sct/embedding/ux/{unix-protocols,unix-tape}.lisp` in
`/opt/symbolics/lib/rel-9-0`, the Portable Genera source tree.)

`rmtd` is a single process that impersonates all of it — rexecd + `/etc/rmt` +
the drive. The "tape" is a regular file in **SIMH `.tap`** format, so filemarks
and multi-file tapes work and images interchange with other tools.

## Run

    sudo ./rmtd --tape /path/to/genera.tap                    # port 512 needs root
    ./rmtd --tape test.tap --host 127.0.0.1 --port 1512 -vv   # testing; -vv traces wire

A missing tape image is created empty. Serves one connection at a time
(a single drive). `-v` traces commands, `-vv` adds replies.

**Security:** like `lpdd`, `rmtd` binds the vmnet bridge `192.168.2.1` by
default and refuses a wildcard bind unless you pass `--insecure-any-interface`.
The rexec credentials Genera sends are accepted and ignored, so anyone who can
reach the port can read the tape image — and erase it, since `MTERASE`
truncates it to zero bytes. The bridge address exists only while the VLM runs,
so a bind failure before the VLM is up is expected.

Root is needed only to bind port 512: `rmtd` drops to `$SUDO_USER` (override
with `--user`) as soon as the bind succeeds, so the request loop runs
unprivileged. The rmt `O` command's device name is ignored — the only file
served is the `--tape` image. A tape image an *earlier* root run created is
root-owned and will now fail a startup check; `chown` it to yourself.

## Genera namespace setup (important)

Add the `(:TAPE :TCP :UNIX-REXEC)` service to the Mac's host object and set
`tape:*default-tape-host*` to it. The username/password Genera prompts for are
ignored by `rmtd`.

**Leave the Machine Type alone.** Portable Genera creates its own embedding
host with Machine Type `Macintosh` and System Type `macOS`
(`namespaces.lisp`, `emb-host-machine-type` / `emb-host-system-type`; the
`darwin-arm-vlm` arm of each `system-case`). Earlier notes here said to
register the tape host as `DEC-AXP`; do **not** do that to a Portable Genera
emb host — `DEC-AXP` is a machine type, `macOS` is the system type, and the
two are not interchangeable.

Genera picks the rmt dialect from that Machine Type
(`unix-tape.lisp`, `sun-host-p` / `dec-axp-host-p`). `Macintosh` is neither
Sun nor DEC, so the tape stream takes the default ("vax") branch, which differs
from the DEC-AXP branch in four ways — `rmtd` implements all four:

  * it **does** issue the binary `S` (status) command, at mount and on every
    ready/BOT check. `rmtd` answers with a real `struct mtget` prefix: drive
    type `0x03` (Unibus TM-11), which is the one type whose status Genera can
    actually decode, plus the online / BOT / EOF / EOT bits
    (`vax-unibus-tm-11-status`);
  * `allow-short-input-records-p` is NIL, so **a short read means EOF**.
    `rmtd` fills each `R` from as many `.tap` records as it takes, stopping only
    at a filemark or end of medium, and splits a record that overruns the
    request. Returning one record per `R` — which is what a DEC-AXP host wants —
    would end every file after its first record;
  * the rexec command is `/etc/rmt`, not `/usr/sbin/rmt`. That is how `rmtd`
    names the dialect in its log (`-v`), which is the quickest way to catch a
    host registered as the wrong machine type;
  * the device string is parsed differently — see below.

A host registered as `DEC-AXP` still works: `rmtd` serves both dialects, and the
read semantics above (never cross a filemark; the following zero-length read
steps over it) are the ones a real Unix tape driver has.

**Device name must be `mt0`**, NOT `mt0h` and never `Cart`. The default dialect
parses the device string as *prefix* + *unit* (`unix-tape.lisp`, the `t` branch
of the `make-instance :after` `cond`): it takes the digits after the last
non-digit as the unit and requires `0 ≤ unit ≤ 3`, so a trailing density letter
(`mt0h`, the DEC-AXP form) leaves no digits to parse and errors. Density comes
from the tape spec, not the name, and must be 800, 1600 or 6250 — it defaults
to 1600 (`lmtape/tape-host.lisp`, `default-tape-density`). `rmtd` ignores the
name it is sent, so unit and density are cosmetic; they just have to parse.

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

rexec handshake; rmt `O`pen/`C`lose/`R`ead/`W`rite/`L`seek/`S`tatus; MTIOCTOP
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
`genera-remote.ts` goes the other way: it connects **into** Genera and drives
it from the host, as an **MCP server** (for Claude Code and other MCP clients)
and as a plain **CLI**, including an interactive full-screen terminal.

It uses two of Genera's own network services:

| Service | Port | Module | Used for |
|---|---|---|---|
| rsh (`UNIX-REXEC-SERVER`) | TCP 514 | `genera-rsh.ts` | `eval`, `command` |
| 3600-LOGIN (`3600-TERMINAL`) | TCP 57 | `genera-3600.ts` | `screen`, `type`, `key`, `wait`, `repl` |

The first version spoke telnet and screen-scraped the Listener. It lost
anything that scrolled past 24 rows, and it could reach special keys only
through ASCII prefix toggles (Function and Select not at all). Both problems
are gone: rsh returns a form's whole output and its values, and 3600-LOGIN
carries full Genera characters.

Three Deno files, no `package.json`. The two protocol modules and the session
are dependency-free. Only the MCP layer reaches for
`npm:@modelcontextprotocol/sdk` (pinned to `1.29.0`, loaded from the local
Deno npm cache and imported lazily, so `deno test` and the CLI never touch
it).

## What Genera must have enabled

These are facts about the Genera side (sources in
`/opt/symbolics/lib/rel-9-0/sys.sct/`); how and whether to set them is up to
you.

  * **rsh** (`embedding/ux/unix-protocols.lisp`, `UNIX-REXEC-SERVER`, the
    same code that serves rexec on 512). The host must be trusted. While
    someone is logged in to Genera, the server refuses to evaluate unless
    `NET:EVAL-SERVER-ON` is set. It is not preserved across a reboot. A
    refusal reads "This machine is in use by …", and the driver appends that
    explanation.
  * **3600-LOGIN** (`network/network-terminal.lisp`, `3600-TERMINAL`). It
    answers only while remote login is on and the connecting host is trusted
    (Secure Subnets). Otherwise the connection is refused, and the driver
    says what is needed.

## Run

    # MCP stdio server (default when no verb) — this is what Claude Code spawns
    ./genera-remote.ts

    # rsh: no login, whole output
    ./genera-remote.ts eval '(+ 1 2)'                 # => 3
    ./genera-remote.ts eval '(progn (print 1) (values 2 3))'
    ./genera-remote.ts command 'Show Herald'

    # 3600-LOGIN: each verb logs in, acts, and logs out
    ./genera-remote.ts screen                         # print the screen
    ./genera-remote.ts type '(+ 1 2)'                 # type text
    ./genera-remote.ts key c-m-Abort                  # press keys, in order
    ./genera-remote.ts wait --pattern 'Command: '
    ./genera-remote.ts keys                           # list key names + codes
    ./genera-remote.ts repl                           # interactive terminal

    # target + output
    --host H          default 192.168.2.2 (the guest on the vmnet bridge; env GENERA_HOST)
    --login-port N    default 57   (env GENERA_LOGIN_PORT)
    --rsh-port N      default 514  (env GENERA_RSH_PORT)
    --timeout-ms N    eval/command/wait
    --json            machine-readable output

`eval` prints what the form printed, then one `=> value` line per value
(printed with `~S`). Exit status: 0 success, 1 error, 2 timeout. The form
must be a **single** form, read in `CL-USER`. Wrap several in `(progn ...)`.
Unbalanced parentheses are caught before sending. A timeout closes only the
client's socket, so a looping form keeps running in Genera. `command`
sends the text as a CP command line. A command's own error report is
ordinary output.

The shebang is `deno run --allow-net --allow-env --allow-read`. `--allow-read`
lets the MCP SDK resolve itself from the Deno cache.

### Per-invocation login

Each 3600 verb opens a fresh login. The server gives the client about two
seconds to send its screen size, then paints the herald and a Listener. So a
verb takes about 2.5 s, and Listener state does not persist between
invocations. Use `repl`, or the MCP server's persistent session, for
continuity.

The Listener activates as soon as a closing paren completes a form. A Return
typed after `(+ 1 2)` is therefore an empty command line, and Genera answers
it with a second prompt.

## Key grammar

`genera_key` and `key` take a spec: optional prefixes `c-` `m-` `s-` `h-`
(control, meta, super, hyper; bits 1, 2, 4, 8) and `sh-`, then a single
character or a key name (case-insensitive):

    Space Suspend Clear-Input Function Help Rubout Backspace Tab Line
    Refresh Page Return Abort Resume End Square Circle Triangle Scroll
    Select Network Escape Complete Symbol-Help

With any modifier, an unshifted letter is sent as its **uppercase** code
(`c-a` is code 65) and `sh-` gives the lowercase (`c-sh-a` is 97); that is
how Genera itself encodes them. Examples: `Return`, `c-m-Abort`, `m-X`,
`Select`, `Function`, `c-sh-a`.

`genera_type`/`type` send unmodified characters: printable ASCII as is, a
newline as Return, a tab as Tab, and the SAIL glyphs (`λ`, `≠`, `∀`, …) as
their Genera codes 0–037.

## `repl`: interactive terminal

A full-screen 3600-LOGIN session in your terminal. The tty goes raw with
autowrap off, and both are restored on exit and on every signal. Resizing
the window sends the new size to Genera live. Codes 0–037 display as their
SAIL glyphs.

| Local key | Genera |
|---|---|
| printable | itself |
| Return | Return |
| Delete | Rubout |
| Tab | Tab |
| Ctrl-letter | c-letter (so Ctrl-H is c-H) |
| Esc then key, or Option-as-Meta | m-key |
| lone Esc | Escape |
| ↑ ↓ → ← | c-P c-N c-F c-B |
| Home / End / PgUp / PgDn | m-< / End / m-V / c-V |
| F1 … F9 | Help, Suspend, Resume, Abort, Refresh, Clear-Input, Function, End, Network |

`Ctrl-]` is the local escape. The next key does:

| Key | Action |
|---|---|
| `q` | log out and quit |
| `h` `a` `e` `s` `r` | Help, Abort, End, Suspend, Resume |
| `c` `f` `n` `l` | Clear-Input, Function, Network, Refresh |
| `x` | Complete |
| `S` | Select |
| `?` | list these |
| `Ctrl-]` | send c-] |

## MCP tools

Registered on the stdio server (`McpServer` + `StdioServerTransport`). Until
`genera_connect` succeeds, only `genera_connect`, `genera_state` and
`genera_log` are listed. The rest appear once the login is up and disappear
when it ends, however it ends. Each change sends `notifications/tools/list_changed`.

  * `genera_eval {form, timeout_ms?, max_lines?}` → over rsh: what the form
    printed, then `=> value` lines, or `error: …`. The error flag is set on error or timeout.
  * `genera_command {text, timeout_ms?, max_lines?}` → over rsh: CP command
    text (e.g. `Show Herald`) and its output.
  * `genera_connect {host?, port?, cols?, rows?}` → logs in over 3600-LOGIN
    and returns the screen once the herald has painted. While connected,
    `cols`/`rows` resize the live session.
  * `genera_disconnect` → sends logout and closes.
  * `genera_screen {mode?}` → the character grid as text.
  * `genera_type {text, mode?, settle_ms?}` → types text, with no Return
    appended.
  * `genera_key {name, mode?, settle_ms?}` → one key spec (grammar above).
  * `genera_wait {pattern?, stable_ms?, timeout_ms?, mode?}` → returns when a
    regex appears **or** the screen is unchanged for `stable_ms`. It fails
    closed (error flag) on timeout. Stability is measured from the moment the
    call begins, so an in-flight repaint always gets a chance to land.
  * `genera_state` → the full session state as JSON: connected, host,
    loginPort, rshPort, cols/rows, cursor, atPrompt, beeps, closeReason.
  * `genera_log {limit?}` → the in-memory action log, one line per entry.

### What a tool result contains

Results are **plain text, not JSON**, and carry as little as the call allows.

  * **Screen.** `mode` selects the rendering. `auto` (the default) diffs
    against the screen the caller was *last shown*:
    `(screen unchanged)` when nothing changed, a few changed rows as `NN| text`
    with 0-based row numbers, or the whole grid after a repaint. `full`
    forces the grid, `changed` forces the diff, and `none` omits it. A mode
    that emits nothing does not move the diff baseline.
  * **Eval and command results** are text, not the screen. `max_lines`
    (default 200) truncates from the middle, keeping head and tail.
  * **Footer.** One bracketed line on screen tools, and only when something
    is off-nominal: `[no-prompt]` (connected, but Genera has not come back,
    or an input line is still open), `[DISCONNECTED]`, `[TIMED OUT 30000ms]`,
    or `[no match, settled 400ms]`.

`genera_type` and `genera_key` settle for `settle_ms` (default 300) before
reading, so the echo they cause is already in the result.

### Registering with Claude Code

This repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "genera": {
      "type": "stdio",
      "command": "/usr/local/bin/deno",
      "args": [
        "run", "--allow-net", "--allow-env", "--allow-read",
        "/Users/ldbeth/Public/Projects/linux-vlm/unix-remote/genera-remote.ts"
      ],
      "env": {
        "GENERA_HOST": "192.168.2.2",
        "GENERA_LOGIN_PORT": "57",
        "GENERA_RSH_PORT": "514"
      }
    }
  }
}
```

## Protocol notes

**rsh.** The client sends `"0\0" user "\0" user "\0" command "\0"`. The
server replies with a lead byte, 0 (accepted) or 1 (rejected, then the
reason), and closes at the end. The text is read preferring a CP command,
else a form, and evaluated with `*STANDARD-OUTPUT*` bound to the socket. The
server catches an error after accepting and writes the report as plain text
after the 0. So `evalForm` wraps the form in `HANDLER-CASE` and marks values
and errors with a random nonce. A read error quotes the wrapper back; the
driver puts the user's form in its place.

**3600-LOGIN.**
  * Input is `1 cols rows` (size, sent at once and on resize),
    `3 bits code` (one Genera character) or `0` (logout).
  * Output is characters 0–0177, where codes 0–037 are SAIL graphics, plus
    eight ops:
    * 0200 beep;
    * 0201 newline, which also clears the new row;
    * 0202 clear and home;
    * 0203 clear to end of window;
    * 0204 clear to end of line;
    * 0205 n insert chars;
    * 0206 n delete chars;
    * 0207 x y set cursor, column first.
  * Characters ≥0200 arrive as `<Name>` text.
  * Genera breaks long lines itself, marking the break with `!` in the
    next-to-last column.
  * The server never relies on autowrap.

## Testing

`genera-remote-test.ts` provides two fakes that stand in for the VLM:

  * `FakeLoginServer` records size messages, decodes `3, bits, code`, paints
    a herald with 3600 ops, echoes, and answers canned forms.
  * `FakeRshServer` parses the four C-strings and replies through a handler.

The suite covers the session against the fakes, the repl key encoder and
terminal, eval/command error handling, and, over the **real** MCP SDK
transport, the tool list and round trips. The codecs have their own suites
(`genera-3600.test.ts`, `genera-rsh.test.ts`).

    deno test --allow-net --allow-env --allow-read --allow-run unix-remote/

`--allow-run` is needed because the MCP test spawns the server as a child. The
SDK must already be in the Deno npm cache, so the tests run offline.

The fakes also run by hand:

    ./genera-remote-test.ts --login-port 5757 --rsh-port 5514 &
    ./genera-remote.ts eval '(* 6 7)' --host 127.0.0.1 --rsh-port 5514
    ./genera-remote.ts screen --host 127.0.0.1 --login-port 5757

## Live verification (against the real VLM)

With the VLM booted and the services above enabled:

  1. `./genera-remote.ts eval '(+ 1 2)'` → `=> 3`.
     `eval '(car 5)'` → `error: The first argument to the CAR instruction,
     5, was not a list or a locative`, exit 1.
  2. `./genera-remote.ts command 'Show Herald'` → the herald.
  3. `./genera-remote.ts screen` → the herald and a `Command:` prompt.
  4. `./genera-remote.ts type '(+ 1 2)'` → the form echoed and `3` below it.
  5. `./genera-remote.ts repl`: resize the window, press F1 for Help, and
     use `Ctrl-] q` to log out.

## Security

There is no TLS and no authentication beyond Genera's host trust. As with
the `telnetd`/`lpdd` notes above, this only ever talks to the **bridge
addresses** (`192.168.2.2` guest / `192.168.2.1` host), which exist only
while the VLM runs. Both services give a trusted host full control of the
world: rsh evaluates arbitrary forms, and 3600-LOGIN is a Lisp Listener. The
driver connects out to a host you name; it never listens.

# SUPDUP client (`supdup.ts`)

An interactive terminal client, like `telnet`, that speaks SUPDUP (RFC 734)
to Genera's remote-login server on TCP 95. Unlike the telnet path, Genera
treats a SUPDUP user as a real display terminal with cursor addressing,
insert/delete line/char, and the full Lisp Machine keyboard (Control, Meta,
Super and Hyper bits, and the Top keys Help, Abort, End and so on). The
client turns Genera's ITS `%TD` display codes into ANSI escapes for
Terminal.app, iTerm or xterm. It is one Deno file with no dependencies.

## Run

    ./supdup.ts [host] [port]            # default 192.168.2.2 95

The shebang is `deno run --allow-net`. The screen size comes from the
terminal when you connect; the client sends it in the option block with
TTYOPT set to erase, move-back, video, insert/delete line and char, and the
full 12-bit character set, but *not* overstrike, SAIL or region scroll.
Genera never writes the last column (its inside width is WIDTH−1). SUPDUP has
no resize message in Genera's server, so after resizing the window you have
to log out and back in. The client turns autowrap off for the session, and
restores it and the tty mode on exit, error or signal.

**The Genera login server must be enabled on the Genera side**: remote login
must be on, and this host must be trusted via Secure Subnets. If it isn't,
the connection is refused and the client says so.

## Keys

Because the client advertises the full character set, Genera reads modifier
bits from `^\` escapes (`034`, `0100`+bits, char), not ASCII control codes.

| Local key                         | Sent to Genera                    |
|-----------------------------------|-----------------------------------|
| printable, Return, Tab, Delete    | as-is (Delete = Rubout)           |
| Ctrl-letter (not Tab/Return/BS)   | c-letter (so Ctrl-L is c-L, not Refresh; Ctrl-Z is c-Z, not Abort) |
| Esc or Option-as-Meta + key       | m-key (Esc Ctrl-f = c-m-F)        |
| lone Esc                          | Escape                            |
| arrows ↑ ↓ → ←                    | c-P c-N c-F c-B                   |
| Home / End                        | m-< / End                         |
| PgUp / PgDn                       | m-V / c-V                         |
| F1 F2 F3 F4 F5                    | Help, Suspend, Resume, Abort, Refresh |
| F6 F7 F8 F9                       | Clear-Input, Function, End, Network |

Esc counts as Meta only when the next key arrives in the same read, which is
what Option-as-Meta produces. Non-ASCII input (UTF-8) is dropped, because a
raw byte `0300` and above would be read as a SUPDUP escape and signal an
error in Genera. There is no way to send c-H: Genera turns it into Resume.

**Ctrl-]** is the local escape, as in telnet. It is followed by one key:

| Key     | Action                          |
|---------|---------------------------------|
| `q`     | log out (`0300 0301`) and close |
| `h` `a` `e` `s` `r` | Help, Abort, End, Suspend, Resume |
| `c` `f` `n` `l`     | Clear-Input, Function, Network, Refresh |
| Ctrl-]  | send c-]                        |
| `?`     | print this list on stderr (then Ctrl-] `l` to repaint) |

## Testing

    deno test --allow-net unix-remote/supdup.test.ts

The protocol core is made of pure exported functions: the option-block
encoder, the `%TD` decoder (whose state carries across chunk boundaries) and
the key encoder. `runSession` takes injected streams. The suite checks the
6-bit option packing, each `%TD` code with arguments split across chunks, and
the key map. It also runs two socket round trips against an in-process fake
server that sends Genera's greeting, parses the option block back, and then
either paints a screen or waits for the logout. A non-interactive connection
to the live VLM received the herald and a `Command: ` prompt, and Ctrl-] `q`
logged out cleanly.

The same security note applies as for telnet above. The link is plain TCP
with no encryption, and a trusted SUPDUP login is a Lisp Listener.
