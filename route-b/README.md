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
| C MINI coexist demux (`MINI_COEXIST`) | built + unit-tested |
| Server-enable script (in-core namespace, rerun per cold boot) | `enable-chaos-server.lisp` |

## Server bring-up (og2vlm, "A", 192.168.2.2 / ETHERNAL)

1. `cd og2vlm && sleep 2 && sudo ./genera` (og2vlm.sh).
2. Log in on the console (or telnet in as LISP-MACHINE).
3. Load the enable script over NFS.  The NFS export covers only
   `/Users/ldbeth/Public/symbolics` (`/etc/exports`), so a copy of the
   script is staged at `symbolics/route-b/` — re-copy it there after
   editing the repo original:

       (load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/enable-chaos-server.lisp")

   This creates the CHAOS network object if missing, gives the local
   host address `401` plus `:FILE CHAOS NFILE` service, and does a
   general network reset (drops telnet; reconnect).  It is idempotent.
   The edits are in-core only — rerun after every cold boot of A.

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
    sudo GENERA_SYS_ROOT=/Users/ldbeth/Public/symbolics/rel-8-5/sys \
         MINI_COEXIST=1 GENERA_HALT_DUMP=fresh-qld.pmd ./genera

The `CHAOS|402` component is REQUIRED, not decorative: the C MINI
server only starts when the network spec chain has a CHAOS element
(network-darwin.c MiniServerStart gate) — `GENERA_SYS_ROOT` alone
silently gets you no `MINI server:` boot line.  The guest adopts 402
as its own chaos address from this spec (SETUP-MY-CHAOS-ADDRESS reads
the FEP boot option).  Do NOT append `;host=401`: spec options are
echoed verbatim into the guest-visible address string and the cold
world's integer parser FERRORs on the `;` ("Garbage character seen
while parsing integer") — the in-process MINI server defaults to 401
anyway; `host=` is only for MOVING it elsewhere, and only warm worlds
tolerate it.  Since B (og2vlm-b) is also chaos 402, don't run B and
the QLD guest at the same time.

Coexist is enabled by `MINI_COEXIST=1` in the environment.  With coexist on, the in-emulator
MINI server still owns the MINI protocol at 401, but:

- chaos-ARP for 401 passes to the wire (A answers with its real MAC), and
- every non-MINI chaos frame to 401 (NFILE RFCs, NFD data channels,
  STATUS/hostat) passes to the wire, where A answers as DIS-SYS-HOST.

Consequences: **boot A first** — with coexist on, the guest cannot even
resolve 401's MAC (and therefore cannot reach the C MINI) until A
answers ARP.  Traffic on the open MINI conversation is classified by
(source address, source index); the guest NCP never reuses a live
index, so MINI and NFILE connections do not collide.

The fresh QLD world already bakes DIS-SYS-HOST = 401 (MINIFS/syshost),
so no client-side namespace fix is needed.  Stock **dist-world** test
clients (like og2vlm-b) do need one: the stock dist namespace has
DIS-SYS-HOST at `#o24620`, whose RFCs rot into broadcast fallback and
vanish.  Load the same file's `(route-b-point-dis-sys-host-at-401)` on
such clients.

## Next session: resume checklist → attempt 21

State when the VLMs were shut down (2026-08-01): serving tree, `>wobbly>`,
and everything on LMFS **persist** (fep0.dsk).  A's chaos address / NFILE
service and B's DIS-SYS-HOST fix are **in-core only and are now gone** —
step 2 below restores the server side; B is only needed again as a debug
client.  The rebuilt `src/genera` (MINI_COEXIST support) is what both
instance dirs symlink, so it runs on next launch.

1. **Commit first**: `life-support/mini-server.c`, `mini-server-test.c`,
   `route-b/` are uncommitted.  (Standing deploy rule: run from committed
   source.)  Re-run the unit harness if anything changed:
   `cc -DMINI_STANDALONE -o /tmp/mini-test life-support/mini-server-test.c
   && /tmp/mini-test` → 42 ok.
2. **Boot + enable the server (A)**: `cd og2vlm && sleep 2 && sudo ./genera`,
   log in (console or telnet, LISP-MACHINE works), then
   `(load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/enable-chaos-server.lisp")`
   — expect the telnet connection to drop at the end (network reset);
   reconnect and check `chaos:my-address` ⇒ 257.
3. **Optional sanity from B** (og2vlm-b, dist world): boot it, run
   `(route-b-point-dis-sys-host-at-401)` from the same file, then the
   verification snippets below.  Skip when confident — the QLD guest is
   the real test.
4. **Stage-A live test of coexist = attempt 21's cold phase**: launch the
   QLD guest exactly as attempt 20 (fresh.ilod + `GENERA_SYS_ROOT` for the
   C MINI) **plus `MINI_COEXIST=1`**, A already up (rule: guest can't
   ARP-resolve 401 until A answers).  Boot line must read
   `MINI server: chaos 401 serving ... (coexist: non-MINI traffic passes
   to the wire)`.  The MINI inner-system load exercises coexist's claim
   path; the first NFILE open exercises passthrough.
5. **Attempt 21**: `(si:qld :gc-on nil)` — the ephemeral-GC bug is still
   unpatched in the fresh world; never `:gc-on t`.
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
