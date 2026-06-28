# unix-remote — fake tape server for the Genera VLM

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
