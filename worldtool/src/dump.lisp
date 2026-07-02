;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; Reading dispatch and human-readable dumps.

(in-package #:worldtool)

(defun read-world (path)
  (let* ((buf (read-file-bytes path))
         (cookie (le32 buf 0)))
    (cond ((= cookie +ivory-cookie+) (read-ilod buf))
          ((= cookie +vlm-cookie+) (read-vlod buf))
          ((= cookie +vlm-cookie-swapped+)
           (error "~A is a byte-swapped VLM world; not supported" path))
          (t (error "~A: unrecognized world file cookie #x~8,'0X" path cookie)))))

(defun write-world (model)
  (let ((buf (ecase (world-model-format model)
               (:ilod (write-ilod model))
               (:vlod (write-vlod model)))))
    ;; Preserve original size when known (e.g. trailing slack)
    (let ((size (world-model-file-size model)))
      (cond ((zerop size) buf)
            ((= size (length buf)) buf)
            ((> size (length buf))
             (let ((padded (make-array size :element-type '(unsigned-byte 8)
                                            :initial-element 0)))
               (replace padded buf)
               padded))
            (t (error "Computed world (~D bytes) exceeds recorded file size (~D)"
                      (length buf) size))))))

(defun dump-map (entries label)
  (format t "~&~A map (~D entries):~%" label (length entries))
  (loop for e in entries
        for i from 0
        do (format t "  ~3D: ~(~A~) vma #x~8,'0X count ~D (#x~X)"
                   i (opcode-name (map-entry-opcode e))
                   (map-entry-address e)
                   (map-entry-count e) (map-entry-count e))
           (if (= (map-entry-opcode e) +op-data-pages+)
               (format t " -> file page ~D~%" (map-entry-data-data e))
               (format t " <- q ~2,'0X:~8,'0X~%"
                       (map-entry-data-tag e) (map-entry-data-data e)))))

(defun dump-world (path &key qs)
  (let* ((buf (read-file-bytes path))
         (cookie (le32 buf 0))
         (model (read-world path)))
    (format t "~&~A: ~(~A~) world, ~:D bytes (~:D Ivory pages~@[, ~:D VLM blocks~])~%"
            path (world-model-format model) (length buf)
            (floor (length buf) +ivory-page-size-bytes+)
            (when (eq (world-model-format model) :vlod)
              (floor (length buf) +vlm-block-size+)))
    (format t "cookie #x~8,'0X~%" cookie)
    (format t "header Qs 0..7:~%")
    (dotimes (i 8)
      (multiple-value-bind (tag data) (ivory-read-q buf i)
        (format t "  Q~D: tag #x~2,'0X data #x~8,'0X (~:D)~%" i tag data data)))
    (when (eq (world-model-format model) :vlod)
      (format t "data page base ~D, tags page base ~D (blocks)~%"
              (world-model-data-page-base model)
              (world-model-tags-page-base model))
      (format t "sysout generation ~D, timestamps #x~8,'0X ~8,'0X parent #x~8,'0X ~8,'0X~%"
              (nth-value 1 (ivory-read-q buf 3))
              (nth-value 1 (ivory-read-q buf 4))
              (nth-value 1 (ivory-read-q buf 5))
              (nth-value 1 (ivory-read-q buf 6))
              (nth-value 1 (ivory-read-q buf 7))))
    (dump-map (world-model-wired-map model) "wired")
    (when (world-model-unwired-map model)
      (dump-map (world-model-unwired-map model) "unwired"))
    ;; Optional raw Q hexdump of file pages: QS is (page . count)
    (when qs
      (destructuring-bind (page . count) qs
        (format t "raw Qs of file page~P ~D..~D:~%"
                count page (+ page count -1))
        (dotimes (i (* count +ivory-page-size-qs+))
          (multiple-value-bind (tag data)
              (ivory-read-q buf (+ (* page +ivory-page-size-qs+) i))
            (unless (and (zerop tag) (zerop data))
              (format t "  Q~D+~3D: ~2,'0X:~8,'0X~%"
                      (+ page (floor i +ivory-page-size-qs+))
                      (mod i +ivory-page-size-qs+) tag data))))))
    model))
