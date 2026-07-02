;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; In-memory model of a world file, plus byte-level helpers.

(in-package #:worldtool)

;;; A qvec holds N Qs as parallel tag/data arrays.
(defstruct (qvec (:constructor %make-qvec (tags data)))
  (tags nil :type (simple-array (unsigned-byte 8) (*)))
  (data nil :type (simple-array (unsigned-byte 32) (*))))

(defun make-qvec (n)
  (%make-qvec (make-array n :element-type '(unsigned-byte 8) :initial-element 0)
              (make-array n :element-type '(unsigned-byte 32) :initial-element 0)))

(defun qvec-length (qv) (length (qvec-tags qv)))

(defun qref (qv i) (values (aref (qvec-tags qv) i) (aref (qvec-data qv) i)))

(defun (setf qref-tag) (v qv i) (setf (aref (qvec-tags qv) i) v))
(defun (setf qref-data) (v qv i) (setf (aref (qvec-data qv) i) v))

(defun set-q (qv i tag data)
  (setf (aref (qvec-tags qv) i) tag
        (aref (qvec-data qv) i) data))

;;; One load map entry.  DATA-TAG/DATA-DATA are the entry's third Q verbatim.
;;; For :data-pages, DATA-DATA is the starting file page number and PAYLOAD
;;; (a qvec) holds the entry's COUNT Qs.  ADDRESS-TAG/OP-TAG preserve the tag
;;; bytes of the first two Qs for byte-identical re-emission.
(defstruct map-entry
  (address 0) (opcode 0) (count 0)
  (address-tag 0) (op-tag 0)
  (data-tag 0) (data-data 0)
  (payload nil))

;;; The world model.  HEADER-BYTES holds the entire header region (from
;;; byte 0 up to the first payload byte) verbatim -- producers differ in
;;; how they fill the tail of the header page (Minima pads with fixnum-0
;;; Qs), so bytes, not parsed Qs, are the lossless representation.
(defstruct world-model
  (format :ilod)                ; :ilod | :vlod
  (header-bytes nil)            ; (unsigned-byte 8) vector
  (wired-map nil)               ; list of map-entry
  (unwired-map nil)             ; list of map-entry (ilod only)
  ;; vlod only:
  (data-page-base 0)
  (tags-page-base 0)
  (file-size 0))                ; original file size in bytes (0 = compute)

;;; Byte helpers

(defun read-file-bytes (path)
  (with-open-file (s path :element-type '(unsigned-byte 8))
    (let ((buf (make-array (file-length s) :element-type '(unsigned-byte 8))))
      (read-sequence buf s)
      buf)))

(defun write-file-bytes (path buf)
  (with-open-file (s path :element-type '(unsigned-byte 8)
                          :direction :output :if-exists :supersede
                          :if-does-not-exist :create)
    (write-sequence buf s)))

(declaim (inline le32))
(defun le32 (buf i)
  (logior (aref buf i)
          (ash (aref buf (+ i 1)) 8)
          (ash (aref buf (+ i 2)) 16)
          (ash (aref buf (+ i 3)) 24)))

(defun (setf le32) (v buf i)
  (setf (aref buf i)       (ldb (byte 8 0) v)
        (aref buf (+ i 1)) (ldb (byte 8 8) v)
        (aref buf (+ i 2)) (ldb (byte 8 16) v)
        (aref buf (+ i 3)) (ldb (byte 8 24) v))
  v)

;;; Ivory page packing: 256 Qs per 1280-byte page; each 4-Q group is 20
;;; bytes: 4 tag bytes then 4 LE32 data words (world_tools.c:1344).

(defun ivory-q-offsets (qn)
  "Byte offsets (tag, data) of Q number QN counted from the start of an
Ivory-packed region."
  (let* ((page (floor qn +ivory-page-size-qs+))
         (q (mod qn +ivory-page-size-qs+))
         (base (+ (* page +ivory-page-size-bytes+) (* 20 (ash q -2)))))
    (values (+ base (logand q 3))
            (+ base 4 (* 4 (logand q 3))))))

(defun ivory-read-q (buf qn)
  "Read Q number QN from an Ivory-packed byte region BUF. Returns (values tag data)."
  (multiple-value-bind (toff doff) (ivory-q-offsets qn)
    (values (aref buf toff) (le32 buf doff))))

(defun ivory-write-q (buf qn tag data)
  (multiple-value-bind (toff doff) (ivory-q-offsets qn)
    (setf (aref buf toff) tag
          (le32 buf doff) data)))

(defun ivory-read-qvec (buf start-q count)
  "Read COUNT Qs starting at absolute Q number START-Q into a fresh qvec."
  (let ((qv (make-qvec count)))
    (dotimes (i count qv)
      (multiple-value-bind (tag data) (ivory-read-q buf (+ start-q i))
        (set-q qv i tag data)))))

(defun ivory-write-qvec (buf start-q qv)
  (dotimes (i (qvec-length qv))
    (multiple-value-bind (tag data) (qref qv i)
      (ivory-write-q buf (+ start-q i) tag data))))

(defun region-zero-p (buf start end)
  "True if BUF bytes [START,END) are all zero; else returns first nonzero index."
  (loop for i from start below end
        unless (zerop (aref buf i))
          do (return-from region-zero-p (values nil i)))
  t)

(defun header-q-count (nwired nunwired first-map-q)
  (+ first-map-q (* 3 (+ nwired nunwired))))

(defun ivory-pages-for-qs (nqs)
  (ceiling nqs +ivory-page-size-qs+))
