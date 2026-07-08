# unix-remote — host-side helpers for the Genera VLM

Tools that run on the macOS host to provide Unix-side services the VLM expects
over the network:

  * `rmtd` — fake tape server (rexec + BSD `rmt`); see below.
  * `tapedump` — inspect a `.tap` tape image.
  * `org.pkgsrc.telnetd.plist` — launchd job for a host telnet server.
  * `lpdd` — LPD print server that spools each hardcopy to a file; see below.
  * `org.genera.lpdd.plist` — launchd job for `lpdd`.
  * `psfix` — repairs font encodings (and optionally page order) in spooled Genera PostScript; see below.

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
