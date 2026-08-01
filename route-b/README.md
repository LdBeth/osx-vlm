# Route B: second-VLM NFILE file server for QLD

QLD attempt 20 stopped at the first real file operation: the fresh cold
world asks DIS-SYS-HOST (chaos `#o401`) for NFILE service, and nothing
answered.  Route B answers with a **second live VLM** running the stock
Genera NFILE server off its LMFS, over vmnet guest-to-guest chaos
(validated end-to-end 2026-08-01 with zero C code; see memory
`vlm-nfile-route-derisk`).

## Pieces

| Piece | State |
|---|---|
| Transport (0x0804 + chaos-ARP through vmnet shared mode) | verified |
| Stock NFILE server on the OG2 world (login/dir/read/write) | verified |
| Serving tree `ETHERNAL:>sys>**>` | built 2026-08-01 |
| `>wobbly>` (QLD build log target) | created |
| Lisp MINI server on A (contact MINI, both transfer modes) | `mini-server.lisp`, loopback-verified 2026-08-01 |
| Server-enable script (in-core namespace, rerun per cold boot) | `enable-chaos-server.lisp` |
| C MINI coexist demux (`MINI_COEXIST`) | superseded (see below), kept in tree |

## Server bring-up (og2vlm, "A", 192.168.2.2 / ETHERNAL)

1. `cd og2vlm && sleep 2 && sudo ./genera` (og2vlm.sh).
2. Log in on the console (or telnet in as LISP-MACHINE).
3. Load the enable script over NFS.  The NFS export covers only
   `/Users/ldbeth/Public/symbolics` (`/etc/exports`), so copies of the
   scripts are staged at `symbolics/route-b/` — re-copy after editing
   the repo originals:

       (load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/enable-chaos-server.lisp")

   This creates the CHAOS network object if missing, gives the local
   host address `401` plus `:FILE CHAOS NFILE` service, and does a
   general network reset (drops telnet; reconnect).  It is idempotent.
   The edits are in-core only — rerun after every cold boot of A.
4. Load the MINI server the same way (also once per cold boot):

       (load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/mini-server.lisp")

   It starts a "MINI Server" process listening on contact MINI and
   serving `ETHERNAL:>sys>**>` (NOT this world's SYS:, which points at
   the vbin-pruned `>rel-8-5>sys>` master).  One process per accepted
   connection — a guest that reboots without closing its connection
   parks the old service process but never blocks the next RFC
   (single-process design wedged exactly that way in live test).
   Logs go to `(mini-log)` — never the console; background typeout
   would block the server.  Loopback-verified on A: binary (vbin magic
   F013 0005 F012 A00C byte-perfect) + character + LOST + concurrent
   connections.

## Serving tree

`ETHERNAL:>sys>**>` is a full mirror of the `>rel-8-5>sys>**>` LMFS
master **plus** 412 files that existed only in the host-side copy
(367 vbins — the LMFS master had been pruned of them — incl. every
SCT/CLCP/COMPILER vbin QLD loads, and `i-sys>v-clock.vbin`).  Built by:

1. LMFS→LMFS: per-file `fs:copyf` loop over
   `>rel-8-5>sys>**>*.*.newest` with `:create-directories t`
   (5,039 files, 68 s).  CP `Copy File` prompting is unusable over
   telnet, and `fs:copy-file` does not exist / `fs:copyf` rejects
   wildcards — the loop is the way.
2. Host→LMFS over NFS: `fs:copyf` from
   `COSTUMEPARTY:/Users/ldbeth/Public/symbolics/rel-8-5/sys/...`
   driven by a list file, element-type `:default` (vbin → byte-size 16
   automatically; roundtrip verified byte-identical).  Only the two
   cl-http `.tar.gz` tarballs failed to parse as LMFS names — skipped.

To refresh one file later (e.g. a recompiled vbin):

    (fs:copyf "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/rel-8-5/sys/DIR/FILE"
              "ETHERNAL:>sys>DIR>FILE")

## QLD guest

The guest runs from its own instance dir `og2vlm-qld/` (genera +
VLM_debugger symlinks, `.VLM` below, **no fep0.dsk** — never launch it
from `og2vlm/` while A runs there: A's LMFS disk is open O_RDWR and
the IP would collide):

    genera.network: 192.168.2.4;mask=255.255.255.0;gateway=192.168.2.1;host=192.168.2.1,CHAOS|402
    genera.world: ../og2vlm/fresh.ilod

    cd og2vlm-qld
    sudo GENERA_HALT_DUMP=fresh-qld.pmd ./genera

**No `GENERA_SYS_ROOT`, no `MINI_COEXIST`** — with the Lisp MINI server
on A, the guest runs with no in-emulator interception at all; MINI and
NFILE both cross the wire to A at 401.  **Boot A first** (the guest
must ARP-resolve 401 before anything works).  The `CHAOS|402` spec
component is still REQUIRED — it is where the cold world gets its own
chaos address (SETUP-MY-CHAOS-ADDRESS reads the FEP boot option).  Do
NOT append `;host=...` options: the cold parser FERRORs on the `;`
("Garbage character seen while parsing integer").  Since B (og2vlm-b)
is also chaos 402, don't run B and the QLD guest at the same time.

History (2026-08-01): the first architecture kept the C MINI server
in-guest with a `MINI_COEXIST` demux (MINI claimed in-process,
everything else passed to the wire).  Its MINI phase worked — the full
inner system loaded with A live on the bridge — but the run died near
"Canonicalizing cold load pathnames" with a host-side wild branch
(`Memory fault at PC 0x10000000000 (VMA 0) is not a recorded VM
access`), and the relaunch crashed the guest into the VLM debugger
instead ("error printing").  Nondeterministic, root cause unknown;
dump saved at `og2vlm-qld/fresh-qld.pmd` (28 MB, uninvestigated).  The
Lisp-MINI architecture removes the intercept/injection machinery from
the guest entirely — the original Route-B plan, and a cleaner suspect
list if a crash reproduces.  The C coexist code stays in the tree
(committed 94f8f46) for the rootless / no-second-VLM use case.

The fresh QLD world already bakes DIS-SYS-HOST = 401 (MINIFS/syshost),
so no client-side namespace fix is needed.  Stock **dist-world** test
clients (like og2vlm-b) do need one: the stock dist namespace has
DIS-SYS-HOST at `#o24620`, whose RFCs rot into broadcast fallback and
vanish.  Load the same file's `(route-b-point-dis-sys-host-at-401)` on
such clients.

## Next session: resume checklist → attempt 21

Per cold boot of A, three things restore the server side (everything on
LMFS persists; the namespace edits and the MINI server process are
in-core only):

1. **Boot A**: `cd og2vlm && sleep 2 && sudo ./genera`, log in (console
   or telnet, LISP-MACHINE works).
2. **Enable chaos + NFILE**:
   `(load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/enable-chaos-server.lisp")`
   — expect the telnet connection to drop at the end (network reset);
   reconnect and check `chaos:my-address` ⇒ 257.
3. **Start the MINI server**:
   `(load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/mini-server.lisp")`
   — then `(send *mini-server-process* :whostate)` ⇒ "Chaos Listen".
4. **Launch the QLD guest** from `og2vlm-qld/` (see QLD guest section:
   plain `sudo GENERA_HALT_DUMP=fresh-qld.pmd ./genera`, no env vars,
   A up first).
5. **Attempt 21**: `(si:qld :gc-on nil)` — the ephemeral-GC bug is still
   unpatched in the fresh world; never plain `(si:qld)`.
6. **Known watch-point near the end**: QLD writes
   `DIS-SYS-HOST:>wobbly><version>>vlm-qld-build.log` :OUTPUT.  `>wobbly>`
   exists, but the `<version>` subdirectory does not; if the stock server
   errors on the missing directory rather than creating it, create it on A
   (`(send (fs:parse-pathname "ETHERNAL:>wobbly><n>>x.y") :create-directory)`)
   and retry — the log write is QLD's last act, after LOAD-SYSTEM.

If NFILE stalls silently, it's almost always an addressing problem —
use the counters below before touching code.

## Verification snippets (from any client)

    (chaos:hostat #o401)
    (length (fs:directory-list "DIS-SYS-HOST:>sys>sct>*.vbin.newest"))   ; => 12
    (with-open-file (s "DIS-SYS-HOST:>sys>clcp>lambda-list.vbin"
                       :direction :input :element-type '(cl:unsigned-byte 16))
      (format nil "~4,'0X ~4,'0X ~4,'0X ~4,'0X"
              (read-byte s) (read-byte s) (read-byte s) (read-byte s)))
    ;; => "F013 0005 F012 A00C"

Debug counters when something silently times out: server side
`chaos::*rfc-pkts-in*`; client side `chaos::*pkts-transmitted*` /
`*retransmitted-pkts*`; live ARP tables via
`(send (first neti:*interfaces*) :describe-protocols)`; raw-layer probe
`(chaos:connect #o401 "NFILE")`.
