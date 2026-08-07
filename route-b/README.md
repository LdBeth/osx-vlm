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

## Server A: per-cold-boot runbook (og2vlm, 192.168.2.2 / ETHERNAL)

**This is the authoritative setup procedure.**  Everything on LMFS
persists across boots; the namespace edits and the MINI server process
are **in-core only**, so steps 3 and 4 must be redone after every cold
boot of A.  A must be fully up before the QLD guest launches — the guest
has to ARP-resolve chaos 401 before anything works.

    ┌─ 1. boot A ─┐  ┌─ 2. log in ─┐  ┌─ 3. enable-chaos-server ─┐
    └─ 4. mini-server ─┘  └─ 5. verify ─┘  → only then launch the guest

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
5. **Verify before launching the guest** (all on A):

       chaos:my-address                        ; => 257  (= #o401)
       (send *mini-server-process* :whostate)  ; => "Chaos Listen"
       (chaos:connect 257 "NFILE")             ; => OPEN-STATE, NFILE up

   If any of the three is wrong, fix it now — a half-configured A shows
   up on the guest only as a silent timeout many minutes later.

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

### Rebuild 2026-08-06: LMFS wipe recovery + SYSTEM set compiled

The LMFS was accidentally wiped; after restore only the `>rel-8-5>sys>`
master (5,510 files, still vbin-pruned) and `>sys>site>` (118 files, the
stand-alone site data — exists in NO other tree, do not clobber) remained.
The serving tree was rebuilt with **zero host→LMFS copies** this time:

1. LMFS→LMFS mirror: per-file `fs:copyf` of `>rel-8-5>sys>**>*.*.newest`
   into `>sys>` with `:create-directories t`, skipping `.directory`
   pseudo-entries (5,010 files, 49 s, 0 failures; `>sys>site>` untouched).
2. **The SYSTEM defsystem set was compiled on A itself** (402 vbins) —
   closing the "SYSTEM set not compiled" wall of attempts 21-24.
   `Compile System System` does NOT work: its plan builder (via
   `SCT:MAKE-PLAN-FOR-SYSTEM-1`) probes the 3600-only, absent
   `SYS:SYS;ARITHDEFS.LISP` even with `*current-machine-type*` = `:VLM`,
   and errors out.  Instead the file list is computed host-side from
   `sysdcl.lisp` (SYSTEM + its 33 component subsystems, machine-types
   filtered to VLM, `:root-module nil` and 3600-only modules excluded,
   plus straggler `SYS:SYS;MINI-ALISTS`) → `route-b/compile-list.txt`,
   402 files in sysdcl dependency order, and driven by
   `route-b/qld-compile-driver.lisp`: plain per-file `compile-file` in a
   background process (every module is already loaded in A's world, so no
   loads are needed), log at `route-b/qld-compile-log.txt`.  Result:
   398 OK + 4 expected readtable failures, ~4 min wall clock.
3. **SYS: flip discipline**: the whole compile ran with A's `SYS:`
   temporarily translated to `ETHERNAL:>sys>**>` (saved/restored around
   it), so vbins land in the serving tree, the master stays pristine, and
   `SYS:IO;SYSHOST.VBIN` bakes `DIS-SYS-HOST :chaos-address "401"` with
   `>sys>**>` translations — matching the fresh world's baked SYS:.
4. The 4 `(:type :readtable)` modules (`io>rdtbl`, `clcp>readtable`,
   `clcp>ansi-readtable`, `embedding>rpc>c-readtable`) refuse plain
   compile-file by design; compile with
   `(si:rtc-file "SYS:IO;RDTBL.LISP" "SYS:IO;RDTBL.VBIN")` etc.
   (`RTC: WARNING! ... special case of some other token` chatter is
   normal).
5. Verified: 402/402 vbins probe in `>sys>`; `lambda-list.vbin` magic
   `F013 0005 F012 A00C`; `>wobbly>` recreated; runbook triple
   (my-address 257 / "Chaos Listen" / NFILE OPEN-STATE) green.

### Addendum 2026-08-07: the 402 was short by 62 — full set is 464

The 402-file list had a parser bug: sysdcl machine-type tokens read as
`:VLM` (leading colon) but the host-side filter tested for `VLM`, so
**every module with an explicit `:machine-types` was dropped** — the
whole Ivory/VLM layer (`i-sys>float`, the i-compiler, `gc>igc`, itrap,
the VLM disk drivers, deffepblock/disk-save, 62 files), including NINE
files of the MINI alists (`i-sys>float` is entry #4 of
INNER-SYSTEM-FILE-ALIST — QLD would have died almost immediately).
SCT machine types are literal (`canonicalize-machine-types` never
expands `:imach` to include `:vlm`): a module applies to the VLM iff
its list contains `:VLM` or it has no list.  Corrected list =
`compile-list.txt` (464 files); delta run: 61 OK + 1 fail, ~1 min.

Findings beyond the count fix (oracle: the running dist world's
`:file-id-package-alist` on each generic pathname — 471 of sysdcl's
566 files are recorded loaded; probe script in the git history):

- **`i-compiler>disassemble.lisp` references the AXPI package**
  (Alpha-Ivory native code), which was Symbolics-internal and is in
  neither the OG sources nor the dist world.  The band's own
  `DISASSEMBLE.VBIN.9` contains no AXPI code — the two AXPI blocks in
  the shipped source are `#+VLM`-guarded and postdate the band.
  Band-faithful compile:
  `(let ((cl:*features* (cl:remove :vlm cl:*features*))) (compile-file "SYS:I-COMPILER;DISASSEMBLE.LISP"))`
  (the only other conditional in the file is a `#+3600`/`#-3600` pair,
  unaffected; the "STACK-DESCRIPTION never used" warning is the AXPI
  block's absence and is expected).
- The five fep-fs files the band loads (`l-sys>band`,
  `fep-access-paths`, `fep-fix-blocks`, `fep-salvage`, `fep-stream`)
  are machine-typed `(:|3600| :imach)` in sysdcl so they're outside
  the compile set, but their vbins (`.vbin.1`) ship on the
  `>rel-8-5>sys>` master and the mirror carries them into `>sys>`.
- **`i-sys>trap-dispatch-table.lisp` was never released** (its module
  is `:lisp-load-only`, machine-types `(:imach :vlm)`; the band loaded
  a 1993 `TRAP-DISPATCH-TABLE.VBIN.1` into package DBG).  Recovered
  2026-08-07 by dumping the live `DBG:*TRAP-DISPATCH-TABLES*` (6-slot
  vector; revisions 2/4/5 hold 2048-entry fixnum tables) and
  `*TRAP-DISPATCH-TABLE-VERSIONS*` `#(NIL NIL 3 NIL 1 2)` from A into
  `ETHERNAL:>sys>i-sys>trap-dispatch-table.lisp`, written on A itself.
  Gotcha: package DEBUGGER resolves `make-array` to the ZL one — the
  generated file must say `cl:make-array`/`cl:setf`/`cl:aref`.
  Round-trip verified on A (loads under LET-shadowed specials,
  `EQUALP` element-wise against the band, all 6 slots).  NFS backup:
  `route-b/trap-dispatch-table.lisp`.
- Final state: 464/464 vbins probe in `>sys>`, plus the 5 fep vbins,
  `trap-dispatch-table.lisp`, and `pkgdcl.lisp` (loaded as source).
  Logs: `qld-compile-log-1.txt` (402 run), `-2-delta.txt` (62 run).

## QLD guest

The guest runs from its own instance dir `og2vlm-qld/` (genera +
VLM_debugger symlinks, `.VLM` below, **no fep0.dsk** — never launch it
from `og2vlm/` while A runs there: A's LMFS disk is open O_RDWR and
the IP would collide):

    genera.network: 192.168.2.4;mask=255.255.255.0;gateway=192.168.2.1;host=192.168.2.1,CHAOS|402
    genera.world: ../og2vlm/fresh.ilod

    cd og2vlm-qld
    sudo GENERA_HALT_DUMP=fresh-qld.pmd ./genera

**No `GENERA_SYS_ROOT`** — the emulator no longer has a MINI server, or
a `-minifsroot` / `GENERA_SYS_ROOT` option, to point at one (deleted
2026-08-07).  The guest runs with no in-emulator interception at all;
MINI and NFILE both cross the wire to A at 401.  **Boot A first** (the guest
must ARP-resolve 401 before anything works).  The `CHAOS|402` spec
component is still REQUIRED — it is where the cold world gets its own
chaos address (SETUP-MY-CHAOS-ADDRESS reads the FEP boot option).  Do
NOT append `;host=...` options: the cold parser FERRORs on the `;`
("Garbage character seen while parsing integer").  Chaos 402 is the
guest's alone — the phase-0 de-risk instance `og2vlm-b/` that also used
it was deleted once the transport was verified; if you recreate a second
client, give it a different address or don't run it alongside the guest.

History (2026-08-01): the first architecture kept the C MINI server
in-guest with a `MINI_COEXIST` demux (MINI claimed in-process,
everything else passed to the wire).  Its MINI phase worked — the full
inner system loaded with A live on the bridge — but the run died near
"Canonicalizing cold load pathnames" with a host-side wild branch
(`Memory fault at PC 0x10000000000 (VMA 0) is not a recorded VM
access`), and the relaunch crashed the guest into the VLM debugger
instead ("error printing").  (Post-mortems 2026-08-01 evening: one such
VLM-debugger death was dump-proven to be an ephemeral-GC flip dying in
FIND-FREE-EPHEMERAL-SPACE — see "Attempt 21 findings" below.)  The
Lisp-MINI architecture removes the intercept/injection machinery from
the guest entirely — the original Route-B plan, and a cleaner suspect
list if a crash reproduces.  The coexist demux itself was deleted once
that architecture was abandoned (it lived only in 94f8f46..7625509).  The
C MINI server itself (`life-support/mini-server.c`, its header and its
test harness) was **deleted 2026-08-07**: it owned chaos 401 outright, so
it could never share the wire with A, and the rootless / no-second-VLM
path it was kept for was explicitly closed with it.  The Lisp server on A
is the only MINI server.  Its wire-contract documentation was salvaged
into the header comment of `route-b/mini-server.lisp`.

The fresh QLD world already bakes DIS-SYS-HOST = 401 (MINIFS/syshost),
so no client-side namespace fix is needed.  Stock **dist-world** test
clients (like og2vlm-b) do need one: the stock dist namespace has
DIS-SYS-HOST at `#o24620`, whose RFCs rot into broadcast fallback and
vanish.  Load the same file's `(route-b-point-dis-sys-host-at-401)` on
such clients.

## Full run checklist

1. **Server A** — the five steps of the runbook above, ending with the
   three verification forms.
2. **Launch the QLD guest** from `og2vlm-qld/` (see QLD guest section:
   plain `sudo GENERA_HALT_DUMP=fresh-qld.pmd ./genera`, no env vars,
   A up first).  Use a per-run dump name when a dump matters —
   `GENERA_HALT_DUMP` overwrites the file on every halt, and the dump is
   root-owned.
3. **Run QLD**: `(si:qld :gc-on nil)` — the ephemeral-GC bug is still
   unpatched in the fresh world; never plain `(si:qld)`, on restarts
   either.
4. **Known watch-point near the end**: QLD writes
   `DIS-SYS-HOST:>wobbly><version>>vlm-qld-build.log` :OUTPUT.  `>wobbly>`
   exists, but the `<version>` subdirectory does not; if the stock server
   errors on the missing directory rather than creating it, create it on A
   (`(send (fs:parse-pathname "ETHERNAL:>wobbly><n>>x.y") :create-directory)`)
   and retry — the log write is QLD's last act, after LOAD-SYSTEM.

If NFILE stalls silently, it's almost always an addressing problem —
use the counters below before touching code.

## Attempt 21 findings (2026-08-01 evening)

Two post-mortems (`GENERA_HALT_DUMP` overwrites `fresh-qld.pmd` each
halt — use per-run names when a dump matters) plus source reading:

- **GC facts.**  `SI:QLD`'s `:gc-on` DEFAULT is `(:EPHEMERAL T)` and
  `QLD-RUN-INITIALIZATIONS` applies it right before canonicalize
  (`sys/cold-load.lisp:609/717`) — on the restart branch too, so the
  rule is `:gc-on nil` on EVERY `(si:qld)` invocation.  Only QLD's own
  call (and the GC control panel) ever sets GC-ON.  One dumped run died
  mid-EPHEMERAL-GC-FLIP (`GC-PROCESS → … → FIND-FREE-EPHEMERAL-SPACE →
  WIRED-FERROR → AUX-HALT`, `*SCAV-WORK-DONE*` 85055) — that requires
  GC-ON truthy; if that session really ran `:gc-on nil`, something
  unexplained re-enabled it (OPEN QUESTION).  Belt-and-braces: at any
  emergency breakpoint, `(si:gc-off)` before continuing costs nothing.
- **The host wild-branch crash: ROOT-CAUSED + FIXED (2026-08-01 21:37
  build).**  `processor->i_stage_error_hook` pointed at blanks.c's EMPTY
  `DoIStageError`; the icache fill stamps that hook into cacheline code
  slots (odd half of full-word instructions, end-of-function lines), and
  dispatching one executes the blank's bare `ret` — which on Darwin/arm64
  jumps through iInterpret's pinned-ivory x30 register to TagSpace base
  (0x10000000000).  Latent since the Alpha→C translation on ALL hosts
  (old binaries crashed identically); nothing to do with GC or the wire.
  Fix in stub/stub.c entry: `i_stage_error_hook = &&doistageerror` (the
  real internal label, illegaloperand trap 38).  The enriched fault dump
  in emulator/memory.c (anchors, linkage slots, icache `pcdata`) is what
  cracked it and stays.  Open tail: the crash context showed the guest
  PC just past FUNCTION-SPEC-DEFAULT-HANDLER's object end — with the fix
  that now surfaces as a proper guest trap 38; watch what Genera reports
  there.
- **The first NFILE wall is soft**: at the emergency breakpoint after
  "did not respond to a NFILE request", `(RETURN)` lets the whole
  SYSTEM-SYSTEM-FILE-ALIST (I-INSTRUCTION-SET … FILE-ACCESS-PATHS) fall
  back to MINI (`CATCH 'MINI-RELOAD-FILE`).  The HARD wall is
  `SCT:LOAD-SYSTEM SYSTEM` — real `:FILE` service, no fallback (dump:
  `GET-CONNECTION-FOR-SERVICE → CONNECT "NFILE" → WAIT-FOR-CONNECT →
  host-not-responding`).
- **A's NFILE server is UP** (loopback `(chaos:connect 257 "NFILE")` ⇒
  OPEN-STATE, live-verified).  Prime suspect for the guest's
  "did not respond": after the site change the guest's REAL NCP takes
  its chaos address from the DIS-LOCAL-HOST namespace object (dist
  bakes `#o24426`), not from the `CHAOS|402` spec (that only feeds the
  cold-MINI transport via SETUP-MY-CHAOS-ADDRESS).  Source 24426 =
  subnet 41 ⇒ A's OPN reply cannot route back — the phase-0 B failure,
  mirrored.  **Verify at the breakpoint (guest console):**
  `chaos:my-address` — expect 258 (`#o402`); if it says 10518
  (`#o24426`), fix in-core and reset:

      (let ((chaos (neti:find-object-named :network "CHAOS" nil)))
        (multiple-value-bind (name plist)
            (send net:*local-host* :namespace-view net:*namespace*)
          (setf (cl:getf plist :address) (list (list chaos "402")))
          (neti:update-object-permanently :host net:*namespace* name plist t))
        (neti:general-network-reset))

  then retry (worst case re-run `(si:qld :gc-on nil)` — the restart
  branch re-runs LOAD-SYSTEM).  A-side arrival check: watch
  `chaos::*rfc-pkts-in*` on A tick during the guest's attempt
  (baseline 81 at 21:05).

  RESOLVED LATE 2026-08-01: the address suspicion was wrong —
  `chaos:my-address` = 258 at the guest, and NFILE WORKS (the guest's
  real NCP completed two handshakes with A; the "did not respond" wall
  belonged to the pre-route-B era when nothing served NFILE at all).
  QLD's actual next blocker was a GUEST-SIDE worldtool bug, root-caused
  from the 22:31 fresh-qld.pmd: generic-function constants in cold
  functions are baked NIL + a first-boot patch, but the patch stores a
  name-headed list, not the (SI:*COLD-FIND-GENERIC-FUNCTION-MARKER*
  name) shape, so BOOTSTRAP-DEFGENERIC-CONSTANT-REFERENCES never snaps
  them to real generics.  "Canonicalizing cold load pathnames" arms
  SI:*FUNCTION-SPEC-HASH-TABLES*, and the first (:PROPERTY ...) FDEFINE
  (SYS:CLCP;LAMBDA-LIST.VBIN, first SYSTEM-SYSTEM file, served over
  NFILE) drives FUNCTION-SPEC-DEFAULT-HANDLER's START-CALL-GENERIC
  (GETHASH) through the un-snapped DTP-LIST → deterministic trap 46
  (the whole 0x10000000000 host-crash family before the istage fix).
  The trap-46 emergency breakpoint is NOT (RETURN)-recoverable (the
  handler re-executes the same call).  In-guest escape, typed at the
  breakpoint:

      si::(setq *function-spec-hash-tables* nil)
      si::(mini-reload-file)

  Neither escape works in practice: `(RETURN)` cannot leave a TRAP
  breakpoint (ENTER-DEBUGGER-COLD returns into the microcode trap frame
  and re-traps), and an explicit throw dies in the stack unwinder
  (`Error trap 20 at #<PC 113 in (:INTERNAL *THROW 0
  SI:*THROW-INTERNAL)>` = notnumeric, reading a control word across the
  trap frame).  A trap breakpoint ends the run; a FERROR breakpoint is
  still recoverable.  NOTE also: on the cold-load stream, the "Opening
  SYS:…" lines BELOW the cursor are stale pixels from the earlier load,
  not progress — only text above the cursor is current.

  ROOT CAUSE = ONE WRONG TAG, FIXED 2026-08-02 (worldtool e65d093,
  rebuilt + deployed).  worldtool baked the operand correctly
  (`EF:F8041200`, type 47 = DTP-CALL-GENERIC-PREFETCH) but its first-boot
  patch `(SYS:%P-STORE-CONTENTS <loc> (FIND-GENERIC-FUNCTION-AS-CONSTANT
  'GETHASH))` stores a COMPLETE Q, so the cold stub's LIST return stamped
  DTP-LIST (21) over it; QLD's snapper then filled the real generic
  function in but preserved the wrong tag, so START-CALL-GENERIC-PREFETCH
  never dispatched.  18 such sites in fresh.ilod.  The patch value is now
  wrapped in `(SYS:%SET-TAG value <baked tag byte>)`.

## Attempts 22–24 (2026-08-02): three worldtool defects, all closed

The tag fix let attempt 22 clear `SYS:CLCP;LAMBDA-LIST.VBIN` and six more
SYSTEM-SYSTEM files.  Everything after that was generator-side; the wire
was never at fault again.

- **Attempt 22 — `trap 71 in SCL:DESTRUCTURING-BIND referencing
  #'CLI::CONSTANT-FOLD-FORM`**, loading `SYS:SCT;MAKE-PLAN.VBIN`.
  `make-plan.lisp:292` instantiates a flavor at load time; with no
  compiler the `:PASS-ON` combined method stays interpreted, its body is
  headed by `(DESTRUCTURING-BIND ...)`, and `DIGEST-FORM`
  (`sys/eval.lisp:864`) macroexpands it eagerly because our cold set
  defines `LT:COPYFORMS`.  `CONSTANT-FOLD-FORM` needs
  `COMPILER:OPTIMIZE-FORM`, which loads only with "rest of world".
- **Attempt 23 — two wrong fixes, one boot each.**  Pruning
  `SYS:CLCP;MAPFORMS` broke `LT::EXPAND-LOCF`, which needs `LT:VARIABLEP`
  (mapforms.lisp:492); stamping `LT:COPYFORMS`'s cell unbound instead
  broke `LT::LET-SUBST-COPYFORMS` (subst.lisp:191), reached from
  `EXPAND-LOCF` → `LET-SUBST`.  Both died in the inner-system load of
  `SYS:SCHEDULER;COMETH.VBIN`.  **COPYFORMS is genuinely reachable in the
  cold era** — do not try to make it unavailable again.
- **Attempt 24 — fixed and verified.**  Eager expansion is accepted and
  the missing function is supplied: a generator-installed cold FSET stub
  `CLI::CONSTANT-FOLD-FORM` → `PROG1` (worldtool `a4b0c15`).  Exact, not
  approximate — `defmac.lisp:88` consumes only the primary value, so the
  expander just skips an optimization; Genera uses `PROG1` the same way
  at `cold-load.lisp:146`.  The whole change is one Q (4 bytes).

**Process rule learned the hard way:** `worldtool/tests/run-tests.sh`
validates generator invariants, not the guest boot, so it cannot catch a
cold-set change.  The signal that named both regressions *in advance* was
the R1 unbound-function-cell delta.  After any cold-set or cell-stamp
change, diff the new `fresh.ilod.unbound-fcells.txt` against the last
known-good baseline and account for every ADDED row before deploying.

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
