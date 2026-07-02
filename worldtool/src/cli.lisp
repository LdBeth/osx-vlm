;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; Command-line driver (invoked via the worldtool shell wrapper).

(in-package #:worldtool)

(defun parse-qs-arg (s)
  "Parse PAGE:COUNT."
  (let ((colon (position #\: s)))
    (if colon
        (cons (parse-integer s :end colon)
              (parse-integer s :start (1+ colon)))
        (cons (parse-integer s) 1))))

(defun usage ()
  (format t "usage: worldtool dump FILE [--qs PAGE:COUNT]~%~
             ~7T worldtool export FILE OUT.sexp OUT.qs~%~
             ~7T worldtool emit SPEC.sexp OUT~%~
             ~7T worldtool roundtrip FILE~%")
  1)

(defun main (args)
  (handler-case
      (cond
        ((null args) (usage))
        ((string= (first args) "dump")
         (let ((file (second args))
               (qs (let ((p (position "--qs" args :test #'string=)))
                     (and p (parse-qs-arg (nth (1+ p) args))))))
           (unless file (return-from main (usage)))
           (dump-world file :qs qs)
           0))
        ((string= (first args) "export")
         (destructuring-bind (file sexp qs) (rest args)
           (export-world file sexp qs)
           (format t "~&exported ~A -> ~A + ~A~%" file sexp qs)
           0))
        ((string= (first args) "emit")
         (destructuring-bind (spec out) (rest args)
           (emit-world spec out)
           (format t "~&emitted ~A -> ~A~%" spec out)
           0))
        ((string= (first args) "roundtrip")
         (if (roundtrip (second args)) 0 1))
        (t (usage)))
    (error (e)
      (format *error-output* "~&worldtool: ~A~%" e)
      2)))
