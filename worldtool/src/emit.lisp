;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; S-expression spec <-> world model, lossless export, and emit.
;;;
;;; Two spec flavors, distinguished by which keys are present:
;;;
;;; 1. Lossless export (produced by EXPORT-WORLD):
;;;    (:format :ilod :file-size N
;;;     [:data-page-base N :tags-page-base N]     ; vlod only
;;;     :header-bytes-size N                      ; verbatim, at .qs offset 0
;;;     :map ((:opcode :data-pages :vma #x.. :count N
;;;            :address-tag T :op-tag T :data-tag T :data #x..
;;;            [:payload-offset BYTE-OFFSET-IN-QS-FILE]) ...)
;;;     :qs-file "relative-name")
;;;    The .qs sidecar holds the raw header region first, then per
;;;    :data-pages entry COUNT tag bytes followed by COUNT LE32 data words.
;;;
;;; 2. Hand-written build spec (e.g. specs/hello.sexp):
;;;    (:format :ilod :version-q #x410040
;;;     :entries ((:data-pages :vma #x.. :qs ((cdr type data) ...))
;;;               (:constant :vma #x.. :count 1 :q (cdr type data)) ...))
;;;    File page numbers and the header are synthesized.

(in-package #:worldtool)

(defun read-spec (path)
  (with-open-file (s path)
    (let ((*read-eval* nil))
      (read s))))

;;; ---------------- Lossless export ----------------

(defun export-world (path sexp-path qs-path)
  (let* ((model (read-world path))
         (header (world-model-header-bytes model))
         (offset (length header)))
    (with-open-file (qs qs-path :element-type '(unsigned-byte 8)
                                :direction :output :if-exists :supersede
                                :if-does-not-exist :create)
      (write-sequence header qs)
      (flet ((dump-entry (e)
               (let ((plist (list :opcode (opcode-name (map-entry-opcode e))
                                  :vma (map-entry-address e)
                                  :count (map-entry-count e)
                                  :address-tag (map-entry-address-tag e)
                                  :op-tag (map-entry-op-tag e)
                                  :data-tag (map-entry-data-tag e)
                                  :data (map-entry-data-data e))))
                 (when (map-entry-payload e)
                   (let ((qv (map-entry-payload e)))
                     (setf plist (append plist (list :payload-offset offset)))
                     (write-sequence (qvec-tags qv) qs)
                     (let ((bytes (make-array (* 4 (qvec-length qv))
                                              :element-type '(unsigned-byte 8))))
                       (dotimes (i (qvec-length qv))
                         (setf (le32 bytes (* 4 i)) (aref (qvec-data qv) i)))
                       (write-sequence bytes qs))
                     (incf offset (* 5 (qvec-length qv)))))
                 plist)))
        (let ((spec `(:format ,(world-model-format model)
                      :file-size ,(world-model-file-size model)
                      ,@(when (eq (world-model-format model) :vlod)
                          `(:data-page-base ,(world-model-data-page-base model)
                            :tags-page-base ,(world-model-tags-page-base model)))
                      :header-bytes-size ,(length header)
                      :map ,(mapcar #'dump-entry (world-model-wired-map model))
                      ,@(when (world-model-unwired-map model)
                          `(:unwired-map
                            ,(mapcar #'dump-entry (world-model-unwired-map model))))
                      :qs-file ,(file-namestring qs-path))))
          (with-open-file (out sexp-path :direction :output :if-exists :supersede
                                         :if-does-not-exist :create)
            (with-standard-io-syntax
              (let ((*print-case* :downcase))
                (pprint spec out)
                (terpri out)))))))
    model))

(defun spec-entry-to-map-entry (plist qs-bytes)
  (let ((e (make-map-entry
            :address (getf plist :vma)
            :opcode (opcode-number (getf plist :opcode))
            :count (getf plist :count)
            :address-tag (getf plist :address-tag 0)
            :op-tag (getf plist :op-tag 0)
            :data-tag (getf plist :data-tag 0)
            :data-data (getf plist :data 0))))
    (when (getf plist :payload-offset)
      (let* ((count (map-entry-count e))
             (off (getf plist :payload-offset))
             (qv (make-qvec count)))
        (replace (qvec-tags qv) qs-bytes :start2 off :end2 (+ off count))
        (let ((dbase (+ off count)))
          (dotimes (i count)
            (setf (aref (qvec-data qv) i) (le32 qs-bytes (+ dbase (* 4 i))))))
        (setf (map-entry-payload e) qv)))
    e))

(defun model-from-export (spec spec-path)
  (let* ((qs-path (merge-pathnames (getf spec :qs-file)
                                   (or spec-path *default-pathname-defaults*)))
         (qs-bytes (read-file-bytes qs-path))
         (header-size (getf spec :header-bytes-size)))
    (make-world-model
     :format (getf spec :format)
     :file-size (getf spec :file-size 0)
     :data-page-base (getf spec :data-page-base 0)
     :tags-page-base (getf spec :tags-page-base 0)
     :header-bytes (subseq qs-bytes 0 header-size)
     :wired-map (mapcar (lambda (p) (spec-entry-to-map-entry p qs-bytes))
                        (getf spec :map))
     :unwired-map (mapcar (lambda (p) (spec-entry-to-map-entry p qs-bytes))
                          (getf spec :unwired-map)))))

;;; ---------------- Hand-written build specs ----------------

;;; Header conventions for synthesized ilod worlds, mirroring
;;; og2vlm/VLM_debugger (Minima's builder): the cookie fixes the tags of
;;; Q0..Q3; everything else in the header page carries Type_Fixnum tags,
;;; including the zero fill of the page tail.
(defparameter *ilod-header-tags* (vector #x48 #x49 #x4A #x63))

(defun build-entry (form)
  (destructuring-bind (opcode &key vma count q qs) form
    (ecase opcode
      (:data-pages
       (let* ((qlist qs)
              (n (or count (length qlist)))
              (qv (make-qvec n)))
         (loop for (cdr type data) in qlist
               for i from 0
               do (set-q qv i (tag cdr type) data))
         (make-map-entry :address vma :opcode +op-data-pages+ :count n
                         :address-tag +type-fixnum+
                         :op-tag +type-fixnum+
                         :data-tag +type-fixnum+
                         :payload qv)))
      ((:constant :constant-incremented :copy)
       (destructuring-bind (cdr type data) q
         (make-map-entry :address vma :opcode (opcode-number opcode)
                         :count (or count 1)
                         :address-tag +type-fixnum+
                         :op-tag +type-fixnum+
                         :data-tag (tag cdr type) :data-data data))))))

(defun model-from-build-spec (spec)
  (unless (eq (getf spec :format) :ilod)
    (error "Build specs currently support only :ilod output"))
  (let* ((entries (mapcar #'build-entry (getf spec :entries)))
         (model (make-world-model :format :ilod :wired-map entries))
         (header-pages (assign-ilod-file-pages model))
         (header (make-array (* header-pages +ivory-page-size-bytes+)
                             :element-type '(unsigned-byte 8)
                             :initial-element 0)))
    (setf (world-model-header-bytes model) header)
    ;; Fixnum-tag fill (Minima convention), then the real header Qs.
    (dotimes (q (* header-pages +ivory-page-size-qs+))
      (ivory-write-q header q +type-fixnum+ 0))
    (ivory-write-q header 0 (aref *ilod-header-tags* 0)
                   (getf spec :version-q #x410040))
    (ivory-write-q header 1 (aref *ilod-header-tags* 1) (length entries))
    (ivory-write-q header 2 (aref *ilod-header-tags* 2) 0)
    (ivory-write-q header 3 (aref *ilod-header-tags* 3) 0)
    (synthesize-map-qs model +ivory-first-map-q+)
    model))

(defun emit-world (spec-path out-path)
  (let* ((spec (read-spec spec-path))
         (model (if (getf spec :header-bytes-size)
                    (model-from-export spec spec-path)
                    (model-from-build-spec spec))))
    (write-file-bytes out-path (write-world model))
    model))

;;; ---------------- Round trip ----------------

(defun compare-bytes (a b)
  "Return T if equal, else print the first difference and counts."
  (let ((n (min (length a) (length b)))
        (diffs 0) (first-diff nil))
    (dotimes (i n)
      (unless (= (aref a i) (aref b i))
        (unless first-diff (setf first-diff i))
        (incf diffs)))
    (cond ((and (= (length a) (length b)) (zerop diffs)) t)
          (t (format t "~&MISMATCH: sizes ~:D vs ~:D~@[, ~:D differing bytes, first at #x~X (page ~D)~]~%"
                     (length a) (length b)
                     (and first-diff diffs) first-diff
                     (and first-diff (floor first-diff +ivory-page-size-bytes+)))
             nil))))

(defun roundtrip (path)
  (let* ((original (read-file-bytes path))
         (model (read-world path))
         (rewritten (write-world model)))
    (if (compare-bytes original rewritten)
        (progn (format t "~&~A: roundtrip OK (~:D bytes)~%" path (length original))
               t)
        nil)))
