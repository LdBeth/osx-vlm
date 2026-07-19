;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: SYSTEM-INTERNALS; Base: 10; Lowercase: Yes -*-
;;; One-shot (v2): migrate self-evaluating symbol-cell tables out of
;;; permanent-level CONSTANTS-AREA regions, at the Lisp level.
;;;
;;; Why: the OG2 base world ships with its self-evaluating cell table in
;;; a permanent-level read-only CONSTANTS-AREA region (Symbolics' own
;;; cut left it there; MAKE-STATIC-REGIONS-DYNAMIC deliberately skips
;;; read-only regions, so it was never normalized).  GC-SYMBOLS forwards
;;; that table into weakspace and then never finds the copy again (the
;;; flip doesn't cover permanent regions, and its raw %AREA-NUMBER tests
;;; don't chase forwarding), ending with thousands of dangling weakspace
;;; references -- the guard refuses the reset; stock code freed the
;;; regions and died on the next keyword reference (jj's "GC-SYMBOLS ...
;;; weakspace crashes").
;;;
;;; What this does, per table in a permanent CONSTANTS-AREA region:
;;; build a fresh :SELF-EVALUATING table under the area's normal bits,
;;; copy each bound cell, and repoint the SYMBOL's own value cell
;;; directly at the new cell (verified first: cell value is a symbol
;;; whose value cell forwards back to this cell).  The old table is left
;;; holding its raw symbol values -- inert strong references, correct
;;; forever since self-evaluating values never change -- so NO chain
;;; passes through it and nothing can decay.  Cells that don't verify
;;; fall back to a one-q-forward to the new cell (counted; only those
;;; could ever need attention again).  No region bits are touched;
;;; nothing is flipped that stock code wouldn't flip.
;;;
;;; (v1 of this file instead left the old table as a forwarding shim;
;;; that shim decayed at every symbol-reclaiming GC -- retire-shim.lisp
;;; exists to fix worlds migrated with v1.)
;;;
;;; Run in a FRESH BOOT, before any release GC (it refuses once
;;; weakspace is populated).  Acid test afterwards:
;;; (si:immediate-gc :mode :layered-system-release) TWICE -- both must
;;; finish without "Not resetting SYSTEM-WEAKSPACE-AREA".  Save World
;;; then makes the fix permanent.  Defines nothing, records nothing.

(let ((victims nil))
  (do-area-regions (region system-weakspace-area)
    (when (plusp (region-free-pointer region))
      (error "SYSTEM-WEAKSPACE-AREA is not empty: a release GC already ran in ~
	      this boot.  Cold boot and load this file before any GC.")))
  (dolist (table *all-forwarded-symbol-cell-tables*)
    (when (and (= (%area-number table) constants-area)
	       (= (ldb %%region-level (region-bits (%region-number table)))
		  %permanent-level))
      (push table victims)))
  (if (null victims)
      (format t "~&No self-evaluating cell tables in permanent CONSTANTS-AREA ~
		 regions; nothing to migrate.~%")
      (process:with-lock (*forwarded-symbol-cell-table-lock*)
	(with-read-only-inhibited
	  (dolist (old victims)
	    (let* ((fp (fill-pointer old))
		   (bound (loop for i below fp
				count (location-boundp (aloc old i))))
		   (new (make-forwarded-symbol-cell-table (+ bound 1000)
							  :self-evaluating))
		   (index 0)
		   (repointed 0)
		   (shimmed 0))
	      (loop for i below fp
		    as from = (aloc old i)
		    when (location-boundp from)
		      do (let* ((to (aloc new index))
				(value (location-contents from))
				(symcell (and (symbolp value)
					      (%make-pointer-offset
						dtp-locative value 1))))
			   (without-interrupts
			     (%p-copy-q from to)
			     (if (and symcell
				      (= (%p-data-type symcell) dtp-one-q-forward)
				      (= (%p-pointer symcell) (%pointer from)))
				 (progn
				   ;; Repoint the symbol straight at the new
				   ;; cell; the old cell keeps its raw value.
				   (%p-store-tag-and-pointer
				     symcell dtp-one-q-forward to)
				   (incf repointed))
				 (progn
				   ;; Fallback: forward the old cell.
				   (%p-store-tag-and-pointer
				     from dtp-one-q-forward to)
				   (incf shimmed))))
			   (incf index)))
	      (setf (fill-pointer new) index)
	      (when (eq old *current-self-evaluating-symbol-table*)
		(setq *current-self-evaluating-symbol-table* new))
	      (setq *all-forwarded-symbol-cell-tables*
		    (delq old *all-forwarded-symbol-cell-tables*))
	      (format t "~&Migrated ~D cell~:P (of ~D slots) from ~S into ~S:~@
			 ~D symbol~:P repointed directly (old table now inert), ~
			 ~D via forwarding~:[~; -- INVESTIGATE if nonzero~].~%"
		      index fp old new repointed shimmed (plusp shimmed)))))))
  (format t "~&Cell tables now:~:{~%  ~S in ~A~:[~; (PERMANENT level)~]~}~%"
	  (mapcar #'(lambda (table)
		      (list table
			    (area-name (%area-number table))
			    (= (ldb %%region-level
				    (region-bits (%region-number table)))
			       %permanent-level)))
		  *all-forwarded-symbol-cell-tables*)))
