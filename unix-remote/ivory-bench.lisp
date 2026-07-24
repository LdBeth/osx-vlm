;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: CL-USER; Base: 10 -*-
;;;
;;; Dynamic benchmark suite for the VLM interpreter, driven over the
;;; genera-remote MCP (telnet) against a running Genera 8.5.
;;;
;;; Purpose: rank interpreter codegen changes (stub/process.lisp) by
;;; emulated wall-clock instead of static instruction counts, which
;;; proved misleading (2026-07-24).  Kernels target the paths the
;;; generator changes touch:
;;;
;;;   bench-fixnum   dispatch + fixnum ALU        (control)
;;;   bench-list     car/cdr memory-reads         (dataread/cdr masks)
;;;   bench-array    aref memory-reads            (header mask, array regs)
;;;   bench-fib      function call/return, stack
;;;   bench-cons     allocation + datawrite path  (GC flips expected)
;;;   bench-special  special-variable reads       (bindread path)
;;;
;;; Usage over the MCP: eval each defun, then
;;;   (mapcar #'compile '(bench-fixnum bench-list bench-array
;;;                       bench-fib bench-cons bench-special))
;;;   (defvar *bl* (make-list 1000 :initial-element 1))
;;;   (defvar *ba* (make-array 1000 :initial-element 1))
;;; then time three passes of:
;;;   (time (bench-fixnum 50000000)) (time (bench-list *bl* 40000))
;;;   (time (bench-array *ba* 40000)) (time (bench-fib 33))
;;;   (time (bench-cons 200000)) (time (bench-special 50000000))
;;; Each pass runs ~15 s.  Genera's TIME prints microsecond-resolution
;;; elapsed time; take the min of the passes per kernel.  bench-cons
;;; triggers ephemeral-GC flips; expect higher variance there.

(defun bench-fixnum (n)
  (let ((s 0))
    (dotimes (i n) (setq s (logand #xffffff (+ s i))))
    s))

(defun bench-list (l n)
  (let ((s 0))
    (dotimes (i n)
      (do ((p l (cdr p))) ((null p))
        (setq s (logand #xffffff (+ s (car p))))))
    s))

(defun bench-array (a n)
  (let ((s 0) (m (length a)))
    (dotimes (i n)
      (dotimes (j m)
        (setq s (logand #xffffff (+ s (aref a j))))))
    s))

(defun bench-fib (n)
  (if (< n 2) n (+ (bench-fib (- n 1)) (bench-fib (- n 2)))))

(defun bench-cons (n)
  (let ((x nil))
    (dotimes (i n) (setq x (make-list 100)))
    (length x)))

(defvar *bench-val* 42)

(defun bench-special (n)
  (let ((s 0))
    (dotimes (i n) (setq s (logand #xffffff (+ s *bench-val*))))
    s))
