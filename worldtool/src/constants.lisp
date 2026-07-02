;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; Tag/type/opcode constants mirrored from emulator/aihead.h and
;;; include/world_tools.h.  Values are normative there; keep in sync.

(in-package #:worldtool)

;;; Data types (emulator/aihead.h)
(defconstant +type-fixnum+            8)
(defconstant +type-small-ratio+       9)
(defconstant +type-single-float+     10)
(defconstant +type-nil+              20)
(defconstant +type-locative+         25)
(defconstant +type-compiled-function+ 28)
(defconstant +type-character+        35)
(defconstant +type-even-pc+          38)

;;; Cdr codes (emulator/aihead.h)
(defconstant +cdr-next+   0)
(defconstant +cdr-nil+    1)
(defconstant +cdr-normal+ 2)

(defun tag (cdr type) (logior (ash cdr 6) type))

;;; World file formats (include/world_tools.h)
(defconstant +ivory-page-size-qs+    256)
(defconstant +ivory-page-size-bytes+ 1280)

(defconstant +vlm-page-size-qs+ 8192)
(defconstant +vlm-block-size+   8192)
(defconstant +vlm-blocks-per-data-page+ 4)
(defconstant +vlm-blocks-per-tags-page+ 1)
(defconstant +vlm-maximum-header-blocks+ 14)

;;; Cookies are the tag bytes of header Q0..Q3 read as a 32-bit LE word.
;;; ilod: (cdr-nil    | fixnum, small-ratio, single-float, character)
;;; vlod: (cdr-normal | fixnum, small-ratio, single-float, character)
(defconstant +ivory-cookie+ #x634A4948)     ; bytes 48 49 4A 63
(defconstant +vlm-cookie+   #xA38A8988)     ; bytes 88 89 8A A3
(defconstant +vlm-cookie-swapped+ #x88898AA3
  "Byte-swapped VLM world (big-endian producer); worldtool detects but does not model these.")

;;; Header Q indices
;; Ivory format (.ilod): sysout Qs unused (FirstSysoutQ == 0 disables them)
(defconstant +ivory-wired-count-q+   1)
(defconstant +ivory-unwired-count-q+ 2)
(defconstant +ivory-first-map-q+     8)
;; VLM format V1
(defconstant +vlm-v1-version-and-architecture+ #o40000200)
;; VLM format V2 (.vlod)
(defconstant +vlm-v2-version-and-architecture+ #o40000201) ; = #x800081
(defconstant +vlm-wired-count-q+  1)
(defconstant +vlm-page-bases-q+   2)
(defconstant +vlm-first-sysout-q+ 3)                        ; Qs 3..7
(defconstant +vlm-first-map-q+    8)

;;; Load map opcodes (include/world_tools.h)
(defconstant +op-data-pages+            0)
(defconstant +op-constant+              1)
(defconstant +op-constant-incremented+  2)
(defconstant +op-copy+                  3)

(defun opcode-name (op)
  (case op
    (0 :data-pages) (1 :constant) (2 :constant-incremented) (3 :copy)
    (t op)))

(defun opcode-number (op)
  (etypecase op
    (integer op)
    (keyword (ecase op
               (:data-pages 0) (:constant 1)
               (:constant-incremented 2) (:copy 3)))))
