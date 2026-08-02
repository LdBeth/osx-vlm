;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: USER; Base: 10; Patch-File: T -*-
;;; Patch file for Private version 0.0
;;; Reason: Function SI:%COPY-BITS:  ...
;;; Written by jm, 6/11/21 12:01:22
;;; while running on KRONOS from J:Standard.vlod
;;; with Open Genera 2.0, Genera 8.5, Logical Pathnames Translation Files NEWEST,
;;; NFSv3 Client 10.0, LMFS 445.0, CLIM 72.0, Genera CLIM 72.0, CLX CLIM 72.0,
;;; PostScript CLIM 72.0, CLIM Documentation 72.0, Metering 444.0,
;;; Metering Substrate 444.1, Conversion Tools 436.0, MacIvory Support 447.0,
;;; Statice Runtime 466.1, C 440.0, Lexer Runtime 438.0, Lexer Package 438.0,
;;; Minimal Lexer Runtime 439.0, Lalr 1 434.0, Context Free Grammar 439.0,
;;; Context Free Grammar Package 439.0, C Runtime 438.0,
;;; Compiler Tools Package 434.0, Compiler Tools Runtime 434.0, C Packages 436.0,
;;; Syntax Editor Runtime 434.0, C Library Headers 434,
;;; Compiler Tools Development 435.0, Compiler Tools Debugger 434.0,
;;; C Documentation 426.0, Syntax Editor Support 434.0, LL-1 support system 438.0,
;;; Fortran 434.0, Fortran Runtime 434.0, Fortran Package 434.0, Fortran Doc 427.0,
;;; Pascal 433.0, Pascal Runtime 434.0, Pascal Package 434.0, Pascal Doc 427.0,
;;; Statice 466.0, Statice Browser 466.0, Statice Documentation 426.0,
;;; Statice Server 466.2, Symbolics Concordia 444.0, Image Substrate 440.4,
;;; Essential Image Substrate 433.0, Graphic Editor 440.0, Graphic Editing 441.0,
;;; Bitmap Editor 441.0, Graphic Editing Documentation 432.0, Postscript 436.0,
;;; Concordia Documentation 432.0, Lock Simple 437.0, Joshua 237.3,
;;; Joshua Metering 206.0, Joshua Documentation 216.0, Macsyma 421.83, HOME-SITE 6.0,
;;; HOME-TOOLS 3.0, Experimental Harbison Steele Doc 425.0,
;;; Experimental Hardcopy Restriction 420.0, Ivory Revision 5, VLM Debugger 329,
;;; Genera program 9.1, DEC OSF/1 V4.9 (Rev. 0.6),
;;; 1280x912 24-bit TRUE-COLOR X Screen INTERNET|127.0.0.1:0.0 with 224 Genera fonts (The X.Org Foundation R11902000),
;;; Machine serial number 282245300,
;;; Use embedding hosts time instead of asking the network (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/use-host-time.),
;;; Host ll address (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/vlm-network-patches/host-ll-address.),
;;; Allow multiple ll addresses (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/vlm-network-patches/allow-multiple-ll-addresses.),
;;; pass blocksize to embedded (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/attach-disk-blocksize.),
;;; disable GC during user disk io (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/lmfs/user-disk-without-gc.),
;;; new elements unix-cwd, unix-home-dir,
;;;  new coprocessor-register unixCrypt (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/lmfs/emb-comm-area.),
;;; more emb eth packets and disk buffers (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/emb-bufs.),
;;; automatically attach/detach fep disk(s) (from J:/home/jm/Downloads/lmfs/loadfepdisks.),
;;; Remove function keys from mapping alist patch (from LMFS:HOME;SITE;REMOVE-FUNCTION-KEYS-FROM-MAPPING-ALIST-PATCH.LISP.1),
;;; Clos arglist (from LMFS:HOME;SITE;CLOS-ARGLIST.LISP.2),
;;; The Add Patch Changed Definitions Commands now ignore the SAVE-TICK (from LMFS:HOME;SITE;PATCH-CHANGED.LISP.1),
;;; Avoid errors when DBG:COMPILED-FUNCTION-SPEC-P gets a symbols that is not FBOUNDP. (from LMFS:HOME;SITE;COMPILED-FUNCTION-SPEC-P.LISP.1),
;;; Namespace (from LMFS:HOME;SITE;NAMESPACE.LISP.1),
;;; Let NETI:READ-OBJECT-FILE-AND-UPDATE-2 properly handle the Class :* (from LMFS:HOME;SITE;NAMESPACE-CLASSES.LISP.2),
;;; DEFLOCF for SI:CTS-READ-LOCATION (from LMFS:HOME;SITE;DEFLOCF.LISP.1),
;;; Do not destructively modify a class when it is examined. (from LMFS:HOME;SITE;CLOS-EXAMINE.LISP.2),
;;; Also handle FLOAT indentation. (from LMFS:HOME;SITE;FLOAT-INDENTATION.LISP.1),
;;; Avoid NCONC on list constants. (from LMFS:HOME;SITE;I-COMPILER.LISP.1),
;;; Pass a Function Spec Object instead of a CLOS Method Object to ZWEI:EDIT-DEFINITION. (from LMFS:HOME;SITE;EDIT-CLOS-METHOD.LISP.4),
;;; Add Support for Package Names of CLOS Methods and Positional Constructors (from LMFS:HOME;SITE;WHO-CALLS-CLOS.LISP.3),
;;; Reduce password queries for Unix Rexec. (from LMFS:HOME;SITE;REXEC.LISP.1),
;;; Lgp3 scale factor (from LMFS:HOME;SITE;LGP3-SCALE-FACTOR.LISP.1),
;;; Define :LGP3 as Canonical Type (from LMFS:HOME;SITE;LGP3-CANONICAL-TYPE.LISP.1),
;;; For ANSI DEFPACKAGE Record Source File (from LMFS:HOME;SITE;ANSI-DEFPACKAGE.LISP.4),
;;; Replace a BREAK by a WARN in SAGE::FILTERED-STRING-FROM-CONTENTS-LIST. (from LMFS:HOME;SITE;SAGE-WARN.LISP.1),
;;; Avoid bad indices for X font tables. (from LMFS:HOME;SITE;X-FONT-INDICES.LISP.1),
;;; Do not replace a Lisp Readtable by the Common-Lisp Readtable. (from LMFS:HOME;SITE;ZWEI-LISP-SYNTAX.LISP.1),
;;; Fix Hash-Table-Bug (from LMFS:HOME;SITE;REHASH.LISP.2),
;;; Allow remembering color alu for string presentations (from LMFS:HOME;SITE;COLOR-HISTORY-PATCH.LISP.1),
;;; Vlm disk save patch (from LMFS:HOME;SITE;VLM-DISK-SAVE-PATCH.LISP.5),
;;; Increase packet buffers patch (from LMFS:HOME;SITE;RETI-INCREASE-PACKET-BUFFERS.LISP.2),
;;; Find free ephemeral space patch (from LMFS:HOME;SITE;RETI-FIND-FREE-EPHEMERAL-SPACE.LISP.1),
;;; Dont route packets between interfaces (from LMFS:HOME;SITE;RETI-PREVENT-ROUTE.LISP.1),
;;; Stack Closure (from LMFS:HOME;SITE;STACK-CLOSURE.LISP.1),
;;; Clim Pathname Merging (from LMFS:HOME;SITE;CLIM-PATHNAME.LISP.2),
;;; Clim List Pane (from LMFS:HOME;SITE;CLIM-LIST-PANE.LISP.2),
;;; Accepting Values Margins (from LMFS:HOME;SITE;ACCEPTING-VALUES-MARGINS.LISP.2),
;;; Avoid Process Block for CLIM:STREAM-INPUT-WAIT when TIMEOUT = 0. (from LMFS:HOME;SITE;CLIM-STREAM-INPUT-WAIT.LISP.2),
;;; Permit Postscript Line Width = 0 (from LMFS:HOME;SITE;POSTSCRIPT-LINE-WIDTH.LISP.1),
;;; Avoid NIL as Pointer Sheet. (from LMFS:HOME;SITE;CLIM-RELAYOUT.LISP.2),
;;; Repaint label (from LMFS:HOME;SITE;REPAINT-LABEL.LISP.1),
;;; Delete Record Errors (from LMFS:HOME;SITE;DELETE-RECORD.LISP.1),
;;; For CLIM:FRAME-CURRENT-PANES also check the CLIM:SHEET-MEDIUM (from LMFS:HOME;SITE;CURRENT-PANES.LISP.1),
;;; Content type in forward patch (from LMFS:HOME;SITE;RETI-CONTENT-TYPE-IN-FORWARD-PATCH.LISP.2),
;;; Experiment with Statice Indexes (from LMFS:HOME;SITE;STATICE-INDEX.LISP.1),
;;; Accept statice dump pathname (from LMFS:HOME;SITE;ACCEPT-STATICE-DUMP-PATHNAME.LISP.2),
;;; Ufs extent map (from LMFS:HOME;SITE;UFS-EXTENT-MAP.LISP.1),
;;; Improve VIEW-ENTITY Handler applicability (from LMFS:HOME;SITE;VIEW-ENTITY.LISP.1),
;;; Fixes e.g. limit(r*(sqrt(z2^2+z1^2-2*r*z1+r^2)+z1-r),r,inf); -> z2^2/2 (from LMFS:HOME;SITE;MACSYMA-LIMIT.LISP.1),
;;; Macsyma Password (from LMFS:HOME;SITE;MACSYMA-PWD),
;;; Avoid loosing Concordia Callers (from LMFS:HOME;SITE;CONCORDIA-CALLERS.LISP.1),
;;; Edit documentation (from LMFS:HOME;SITE;EDIT-DOCUMENTATION.LISP.1),
;;; Move Records on Current Screen (from LMFS:HOME;SITE;MOVE-RECORDS.LISP.1),
;;; Prevent printing backwards in Hardcopy Pages Command for LGP3 printer (from LMFS:HOME;SITE;LGP3-HARDCOPY.LISP.1),
;;; Shadow passwd (from LMFS:HOME;SITE;SHADOW-PASSWD.LISP.4).


(SCT:FILES-PATCHED-IN-THIS-PATCH-FILE 
  "SYS:SYS;LISPFN.LISP.535")


(SCT:NOTE-PRIVATE-PATCH "SUBSEQ bug fix")


;========================
(SCT:BEGIN-PATCH-SECTION)
(SCT:PATCH-SECTION-SOURCE-FILE "SYS:SYS;LISPFN.LISP.535")
(SCT:PATCH-SECTION-ATTRIBUTES
  "-*- Syntax: Zetalisp; Package: SYSTEM-INTERNALS; Mode: LISP; Base: 8 -*-")

(PROGN
#+IMACH
(defwiredfun %copy-bits (bits s-address s-bitpos d-address d-bitpos)
  (macrolet ((combine (mask source destination)
	       `(let ((aluf (%read-internal-register %register-alu-and-rotate-control))
		      (mask ,mask))
		  (%write-internal-register aluf %register-alu-and-rotate-control)
		  (logior (logand ,source mask) (logand ,destination (lognot mask)))))
	     (with-internal-registers ((&rest registers) &body body)
	       (loop for register in registers
		     as variable = (gensym)
		     collect `(,variable (%read-internal-register ,register)) into bindings
		     collect `(%write-internal-register ,variable ,register) into cleanups
		     finally
		       (return
			 `(let ,bindings
			    (unwind-protect
				(progn . ,body)
			      ,@(nreverse cleanups)))))))
    ;; Preserve these registers using an unwind-protect
    (with-internal-registers (%register-bar-2 %register-alu-and-rotate-control)
      (setf (%block-register 1) (%pointer-plus s-address (%fixnum-floor s-bitpos 32.)))
      (setf (%block-register 2) (%pointer-plus d-address (%fixnum-floor d-bitpos 32.)))
      (let ((s-bitpos (%fixnum-mod s-bitpos 32.))
	    (d-bitpos (%fixnum-mod d-bitpos 32.)))
	;; No further uses of BAR 0 in this code, grr...
	(prepare-for-block-write)
	;; Special case short transfers (in particular those where the destination
	;; fits within one word).
	(compiler:%error-when ( bits 32.)
	  (when (= bits 0)
	    (return-from %copy-bits nil))
	  (when ( (+ d-bitpos bits) 32.)	;destination within one word
	    (cond (( (+ s-bitpos bits) 32.)	;source within one word
		   (set-alu-and-rotate-control :byte-r (- d-bitpos s-bitpos) :byte-s -1)
		   #+VLM (%block-read-shift 1 :no-increment t :fixnum-only t))
		  (t
		   (set-alu-and-rotate-control :byte-r (- d-bitpos s-bitpos)
					       :byte-s (- s-bitpos d-bitpos 1))
		   ;; Might need an extra word of source for the destination word
		   (if (> s-bitpos d-bitpos) (%block-read-shift 1 :fixnum-only t))))
	    (%block-write 2
	      (combine (%32-bit-difference (lsh 1 (+ d-bitpos bits)) (rot 1 d-bitpos))
		       (%block-read-shift 1 :fixnum-only t)
		       (%block-read 2 :no-increment t :fixnum-only t)))
	    (return-from %copy-bits nil)))
	;; Set up the rotate control; the test for = is just a tweak, the other clause works
	(if (= s-bitpos d-bitpos)
	    (set-alu-and-rotate-control :byte-r 0 :byte-s -1)
	  (set-alu-and-rotate-control :byte-r (- d-bitpos s-bitpos)
				      :byte-s (- s-bitpos d-bitpos 1))
	  ;; Might need an extra word of source for the first destination word
	  (if (> s-bitpos d-bitpos) (%block-read-shift 1 :fixnum-only t)))
	;; Do partial word at the front of the destination, if any
	(when ( d-bitpos 0)
	  (%block-write 2
	    (combine (lsh -1 d-bitpos)
		     (%block-read-shift 1 :fixnum-only t)
		     (%block-read 2 :no-increment t :fixnum-only t)))
	  (decf bits (- 32. d-bitpos)))
	;; Copy all the complete words, in 8-word chunks at first
	(let ((words (%fixnum-floor bits 32.)))
	  (dotimes (ignore (%fixnum-floor words 8))
	    (let ((w0 (%block-read-shift 1 :fixnum-only t))
		  (w1 (%block-read-shift 1 :fixnum-only t))
		  (w2 (%block-read-shift 1 :fixnum-only t))
		  (w3 (%block-read-shift 1 :fixnum-only t))
		  (w4 (%block-read-shift 1 :fixnum-only t))
		  (w5 (%block-read-shift 1 :fixnum-only t))
		  (w6 (%block-read-shift 1 :fixnum-only t))
		  (w7 (%block-read-shift 1 :prefetch nil :fixnum-only t)))
	      (%block-write 2 w0)
	      (%block-write 2 w1)
	      (%block-write 2 w2)
	      (%block-write 2 w3)
	      (%block-write 2 w4)
	      (%block-write 2 w5)
	      (%block-write 2 w6)
	      (%block-write 2 w7)))
	  ;; Copy remaining words one at a time
	  (dotimes (ignore (%fixnum-mod words 8))
	    (%block-write 2 (%block-read-shift 1 :fixnum-only t))))
	;; Do partial word at the end of the destination, if any
	(when ( (setq bits (%fixnum-mod bits 32.)) 0)
	  (%block-write 2
	    (combine (%32-bit-difference (rot 1 bits) 1)
		     (if ( (%fixnum-mod (- d-bitpos s-bitpos) 32.) bits)
			 ;; Rotate latch contains enough bits to make the destination
			 (%rotate-latch)	;clobbers BYTE-R and BYTE-S
		       ;; Rotate latch doesn't contain enough bits, read more
		       (%block-read-shift 1 :no-increment t :fixnum-only t))
		     (%block-read 2 :no-increment t :fixnum-only t))))))
    nil))

)
