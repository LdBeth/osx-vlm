;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: USER; Base: 10; Patch-File: T -*-
;;; Patch file for Private version 0.0
;;; Reason: Release-mode IMMEDIATE-GC runs the GC-SYMBOLS optimization, whose
;;; "redirecting weakspace pointers" sweep can leave references into
;;; SYSTEM-WEAKSPACE-AREA unsnapped; IMMEDIATE-GC's finish then FREES the
;;; area's regions, and every remaining outside reference dangles into
;;; unallocated virtual memory ("Page fault on unallocated VMA" in
;;; STORAGE::PHT-MISS-HANDLER at the next full sweep, typically Save World's
;;; BEFORE-COLD ephemeral flip).  The failure jj recorded in the in-house
;;; full-gc patch as "GC-SYMBOLS ... disabled, weakspace crashes".
;;;
;;; Fix 1 (root cause): in SYMBOLICS-SYSTEM-RELEASE mode, COMPRESS-DEBUG-INFO
;;; parks debug-info strings in a weakspace array (*WEAK-DEBUG-INFO-STRINGS*)
;;; and releases it only in its own :AFTER-RECLAIM-OLDSPACE phase, which by
;;; default runs after the GC-SYMBOLS sweep, so the reference from the global
;;; was never snapped.  Order GC-SYMBOLS after COMPRESS-DEBUG-INFO.
;;;
;;; Fix 2 (guard): RESET-TEMPORARY-AREA on SYSTEM-WEAKSPACE-AREA first counts
;;; surviving references into the area from outside it and refuses to free it
;;; while any remain.  A skipped reset leaks the weakspace regions in the
;;; saved world; it can never corrupt it.
;;;
;;; WARNING -- never run SYMBOLICS-SYSTEM-RELEASE.  Its GC-SYMBOLS stamps
;;; CONSTANTS-AREA and PKG-AREA permanent while it rebuilds, and its
;;; restore puts back the space bits but not the region level, so regions
;;; created during that window stay at %PERMANENT-LEVEL forever.  The
;;; NEXT release GC never flips them, so a cell table there that was
;;; forwarded into weakspace is missed by the rebuild (its raw
;;; %AREA-NUMBER test doesn't chase the forwarding), leaving an empty
;;; current table and a fully-forwarded carcass pointing into weakspace
;;; -- the state the reset guard refuses on (diagnosed live 7/18/26:
;;; 14716 refs = one 14,711-cell table + header/leader; this is jj's
;;; original "GC-SYMBOLS ... weakspace crashes").  Restamping such
;;; regions static mid-GC so the flip covers them was tried IN AN
;;; ALREADY-POISONED WORLD and crashed it ("too many recursive errors";
;;; re-copying/re-forwarding the forwarded carcass is pathological) --
;;; do not retry in-world repair after a refusal; reboot.  The proper
;;; fix is OG2-patches/migrate-cell-tables.lisp: at a FRESH boot, before
;;; any GC, it migrates the cell tables out of permanent CONSTANTS-AREA
;;; regions cell-by-cell (the FORWARD-SYMBOL-CELL operation), touching
;;; no region bits; after that, repeated :LAYERED-SYSTEM-RELEASE GCs
;;; work.  The re-arm itself is fixed in full-gc-patch (7/19/26): its
;;; IMMEDIATE-GC now binds *FULL-GC-FOR-SYSTEM-RELEASE* to NIL, so
;;; SYMBOLICS-SYSTEM-RELEASE no longer manufactures permanent regions
;;; and is repeatable.  The ban stands only for worlds running an older
;;; full-gc-patch (or stock IMMEDIATE-GC).
;;;
;;; Independent of full-gc-patch and reorder-mem-patch (no shared functions);
;;; load order among the three does not matter.


(SCT:FILES-PATCHED-IN-THIS-PATCH-FILE
  "SYS:GC;FULL-GC.LISP.99"
  "SYS:SYS;LISPFN.LISP.NEWEST")


(SCT:NOTE-PRIVATE-PATCH "Weakspace guard for release GC")


;========================
(SCT:BEGIN-PATCH-SECTION)
(SCT:PATCH-SECTION-SOURCE-FILE "SYS:GC;FULL-GC.LISP.99")
(SCT:PATCH-SECTION-ATTRIBUTES
  "-*- Mode: Lisp; Base: 8; Package: System-Internals -*-")


;; Fix 1: COMPRESS-DEBUG-INFO must be done with SYSTEM-WEAKSPACE-AREA before
;; GC-SYMBOLS' redirect sweep runs.  (ORDER-GC-OPTIMIZATIONS reads this
;; property on every IMMEDIATE-GC, so a plain SETF is a complete fix.)
(setf (get 'gc-symbols 'gc-optimization-order)
      '((:after compress-debug-info)))


(defun weakspace-area-empty-p ()
  (block empty
    (do-area-regions (region system-weakspace-area)
      (when (plusp (region-free-pointer region))
	(return-from empty nil)))
    t))

(defun audit-weakspace-references ()
  "Count live references from outside SYSTEM-WEAKSPACE-AREA into it.
Any such reference would be left dangling if the area's regions were freed;
references from inside the area die with it and are ignored."
  (let ((count 0))
    (without-interrupts
      (do-virtual-memory
	   ((address tag pointer)
	    :oldspace-action :collect
	    :loop-wrapper '(let ((swa system-weakspace-area))
			     (with-fast-storage-accessors (region-area)
			       . body)))
	(when (%pointer-type-p (ldb %%q-type-within-tag tag))
	  (let ((region (%region-number pointer)))
	    (when (and region
		       (= (region-area region) swa)
		       (let ((from-region (%region-number address)))
			 (not (and from-region
				   (= (region-area from-region) swa)))))
	      (incf count))))))
    count))


;========================
(SCT:BEGIN-PATCH-SECTION)
(SCT:PATCH-SECTION-SOURCE-FILE "SYS:SYS;LISPFN.LISP.NEWEST")
(SCT:PATCH-SECTION-ATTRIBUTES
  "-*- Mode: Lisp; Package: SYSTEM-INTERNALS; Base: 10; Lowercase: T -*-")


;; Fix 2: the original comment here says "If you free the regions, you better
;; be damn sure that *nothing* points to them" -- IMMEDIATE-GC's finish frees
;; SYSTEM-WEAKSPACE-AREA's regions without being sure.  Make the reset of
;; that area verify, and refuse (loudly, but safely) when references remain.
(defun reset-temporary-area (area &optional free-regions)
  (or (plusp (%logldb %%region-temporary (area-region-bits area)))
      (fsignal "The area given to RESET-TEMPORARY-AREA, ~S, is not a temporary area."
	       (area-name area)))
  (let ((refs (if (and (eq area system-weakspace-area)
		       (not (weakspace-area-empty-p)))
		  (audit-weakspace-references)
		  0)))
    (if (zerop refs)
	(reset-area area free-regions)
	(format error-output
		"~&Not resetting SYSTEM-WEAKSPACE-AREA: ~D reference~:P from outside ~
		 the area would be left dangling.  The world stays consistent but ~
		 keeps the weakspace regions; investigate before saving a world."
		refs))))
