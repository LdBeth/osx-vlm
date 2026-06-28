;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: USER; Base: 10; Patch-File: T -*-
;;; Patch file for Private version 0.0
;;; Reason: The Darwin Arm64 port swaps DataSpace and TagSpace which would cause memory corruption when GC, this patch fixes that on Lisp side.
;;; Written by Lisp-Machine, 6/28/26 10:11:03
;;; while running on Finale from X:Initial.vlod
;;; with Open Genera 2.0, Genera 8.5, Logical Pathnames Translation Files NEWEST,
;;; NFSv3 Client 10.0, LMFS 445.0, Ivory Revision 5, VLM Debugger 329,
;;; Genera program 9.1, DEC OSF/1 V25.5 (Rev. 0),
;;; 1280x912 24-bit TRUE-COLOR X Screen INTERNET|0.0.0.0:0.0 with 224 Genera fonts (The X.Org Foundation R12101022),
;;; Machine serial number 11014206,
;;; Use embedding hosts time instead of asking the network (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/use-host-time.),
;;; Host ll address (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/vlm-network-patches/host-ll-address.),
;;; Allow multiple ll addresses (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/vlm-network-patches/allow-multiple-ll-addresses.),
;;; pass blocksize to embedded (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/attach-disk-blocksize.),
;;; disable GC during user disk io (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/lmfs/user-disk-without-gc.),
;;; new elements unix-cwd, unix-home-dir,
;;;  new coprocessor-register unixCrypt (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/lmfs/emb-comm-area.),
;;; more emb eth packets and disk buffers (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/emb-bufs.),
;;; SUBSEQ bug fix (from DISTRIBUTION|DIS-EMB-HOST:/home/jm/Downloads/copy-bits.),
;;; Automatically attach/detach fep disk(s) (from X:/Users/ldbeth/Public/symbolics/loadfepdisks.lisp).


(SCT:FILES-PATCHED-IN-THIS-PATCH-FILE 
  "SYS:GC;REORDER-MEMORY.LISP.296")


(SCT:NOTE-PRIVATE-PATCH "Reorder mem patch")


;========================
(SCT:BEGIN-PATCH-SECTION)
(SCT:PATCH-SECTION-SOURCE-FILE "SYS:GC;REORDER-MEMORY.LISP.296")
(SCT:PATCH-SECTION-ATTRIBUTES
  "-*- Mode: LISP; Syntax: Zetalisp; Package: SYSTEM-INTERNALS; Base: 8 -*-")


(DEFUN FIX-REGIONS-AFTER-TRANSPORT (REORDERING INCREMENTAL-P)
  (DECLARE (SAFEGUARDED-FUNCTION) (IGNORE INCREMENTAL-P))
  (CLEAR-CONS-CACHES)
  (DO-AREA-REGIONS (REGION (REORDERING-AREA REORDERING))
    (LET ((BITS (REGION-BITS REGION)))
      ;; Nonreordered objects should go wherever they were previously directed.
      (WHEN (= (LDB %%REGION-SPACE-TYPE BITS) %REGION-SPACE-OLD)
	(SETF (REGION-GC-POINTER REGION)
	      (%LOGDPBS (LDB %%GC-POINTER-REORDERING-LEVEL (REGION-GC-POINTER REGION))
			%%GC-POINTER-COPYSPACE-LEVEL
			#+IMach -1 #+IMach %%GC-POINTER-COPYSPACE-REGION 0)))
      (WHEN (AND (= (LDB %%REGION-SPACE-TYPE BITS) %REGION-SPACE-COPY)
		 (ZEROP (LDB %%REGION-NO-CONS BITS)))
	(SETF (REGION-BITS REGION)
	      (DPBS 1 %%REGION-NO-CONS
		    ;; Preserve this region's own representation type
		    (ldb %%region-representation-type bits) %%region-representation-type
		    (LOGIOR (LOGAND (REORDERING-REGION-BITS-MASK REORDERING)
				    (REORDERING-REGION-BITS REORDERING))
			    (LOGAND BITS (LOGNOT (REORDERING-REGION-BITS-MASK REORDERING))))))
	;; Don't change the space type from COPY to NEW, since that will screw up the
	;; scavenger into not scavenging the region.
	(SHORTEN-REGION REGION)))))

