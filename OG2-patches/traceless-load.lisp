;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: USER; Base: 10 -*-
;;; Traceless loader for the OG2 patch set.
;;;
;;; Loads the eight OG2 patches in order (compiling any whose binary is
;;; missing or older than its source), then removes every record the SCT
;;; patch machinery keeps of where the code came from:
;;;
;;;   - the patch file's generic pathname is deleted from the
;;;     :SOURCE-FILE-NAME property of every function spec it defined,
;;;     leaving the stock SYS: source recorded by each patch section, so
;;;     the definitions look like they were loaded from the distribution
;;;     sources (single-file DEFUN records are collapsed back to the bare
;;;     pathname form stock worlds use);
;;;   - the SI:DEFINITIONS inventory on each patch file's pathname is
;;;     removed;
;;;   - SCT:*PRIVATE-PATCH-INFO* is restored to its pre-load value, so
;;;     the herald advertises nothing.
;;;
;;; Once nothing references them, the patch pathname objects themselves
;;; are collected by FS:GC-PATHNAMES during the release GC
;;; (:LAYERED-SYSTEM-RELEASE or stronger), which the release flow runs
;;; before Save World anyway.
;;;
;;; Usage: Load File <this file> (it locates the patches next to itself,
;;; so load it through the same NFS path the patches live under; the
;;; directory must be writable if any binaries need compiling).  It
;;; defines nothing and records nothing of its own.
;;;
;;; Caveat: this only removes traces of what IT loads.  Cut a release
;;; from a freshly cold-booted stock world and load the patches only
;;; through this file -- copies loaded earlier by hand from other paths
;;; leave records under those pathnames that this cannot reach.
;;; SI:LOGIN-HISTORY, editor buffers, and listener history are separate
;;; session traces, handled elsewhere.

(let ((here (and (variable-boundp sys:fdefine-file-pathname)
		 sys:fdefine-file-pathname))
      (saved-private-patch-info (copy-list sct:*private-patch-info*))
      (patch-names '("reorder-mem-patch"
		     "full-gc-patch"
		     "weakspace-guard-patch"
		     "use-host-time"
		     "host-ll-address"
		     "allow-multiple-ll-addresses"
		     "emb-bufs"
		     "copy-bits"))
      (scrubbed 0))
  (unless here
    (error "Load this file with Load File; it locates the patches relative to itself."))
  (flet ((sibling (name type)
	   (send here :new-pathname :name name :type type :version :newest)))
    ;; Load, compiling first where the binary is missing or stale.
    (dolist (name patch-names)
      (let ((src (sibling name :lisp))
	    (bin (sibling name :bin)))
	(when (or (null (probe-file bin))
		  (< (file-write-date bin) (file-write-date src)))
	  (compile-file src))
	(load bin)))
    ;; Scrub the source records.  Source and binary share one generic
    ;; pathname, so one pass covers both.
    (dolist (name patch-names)
      (let ((gp (send (sibling name :lisp) :generic-pathname)))
	(dolist (entry (send gp :get 'si:definitions))
	  (dolist (fspec (cdr entry))
	    (let ((prop (si:function-spec-get fspec :source-file-name)))
	      (cond ((eq prop gp)
		     (si:function-spec-remprop fspec :source-file-name)
		     (incf scrubbed))
		    ((listp prop)
		     (dolist (type-entry prop)
		       (setf (cdr type-entry) (delete gp (cdr type-entry))))
		     (setq prop (delete-if #'(lambda (type-entry)
					       (null (cdr type-entry)))
					   prop))
		     (cond ((null prop)
			    (si:function-spec-remprop fspec :source-file-name))
			   ((and (null (cdr prop))	;one type,
				 (eq (caar prop) 'defun)	;DEFUN,
				 (null (cddar prop)))	;one file: stock form
			    (si:function-spec-putprop fspec (cadar prop)
						      :source-file-name))
			   (t
			    (si:function-spec-putprop fspec prop
						      :source-file-name)))
		     (incf scrubbed))))))
	(send gp :remprop 'si:definitions)))
    (setq sct:*private-patch-info* saved-private-patch-info)
    (setq si:patch-source-file-pathname nil)
    (format t "~&Loaded ~D patch files; scrubbed ~D definition records.~@
	       The pathname objects themselves are collected by the release GC.~%"
	    (length patch-names) scrubbed)))
