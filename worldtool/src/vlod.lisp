;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; VLM (.vlod) world file reader/writer.
;;; Reference: src/world_tools.c OpenWorldFile (V1/V2 header),
;;; VLMLoadMapData (data/tags block layout), CanonicalizeVLMLoadMapEntries,
;;; WriteVLMWorldFileHeader, WriteVLMWorldFilePages.
;;; The header/map region uses Ivory packing; page data lives in 8192-byte
;;; blocks: data words of file page N at block dataPageBase + 4N, tag bytes
;;; at block tagsPageBase + N.

(in-package #:worldtool)

(defun read-vlod (buf)
  (multiple-value-bind (vtag version) (ivory-read-q buf 0)
    (declare (ignore vtag))
    (unless (member version (list +vlm-v1-version-and-architecture+
                                  +vlm-v2-version-and-architecture+))
      (error "Unrecognized VLM world version/architecture Q: #x~X" version))
    (let ((v2 (= version +vlm-v2-version-and-architecture+)))
      (multiple-value-bind (nil-tag nwired)
          (ivory-read-q buf +vlm-wired-count-q+)
        (declare (ignore nil-tag))
        (multiple-value-bind (nil-tag bases)
            (ivory-read-q buf (if v2 +vlm-page-bases-q+ 3))
          (declare (ignore nil-tag))
          (let* ((data-page-base (ldb (byte 28 0) bases))
                 (tags-page-base (ldb (byte 4 28) bases))
                 (first-map-q +vlm-first-map-q+)
                 ;; Header region = everything before the tags blocks
                 (header (subseq buf 0 (* tags-page-base +vlm-block-size+)))
                 (wired (parse-map-entries buf first-map-q nwired)))
            (dolist (e wired)
              (when (= (map-entry-opcode e) +op-data-pages+)
                (setf (map-entry-payload e)
                      (vlod-read-payload buf data-page-base tags-page-base
                                         (map-entry-data-data e)
                                         (map-entry-count e)))))
            (make-world-model :format :vlod
                              :header-bytes header
                              :wired-map wired
                              :data-page-base data-page-base
                              :tags-page-base tags-page-base
                              :file-size (length buf))))))))

(defun vlod-read-payload (buf data-page-base tags-page-base file-page count)
  (let ((qv (make-qvec count))
        (doff (* +vlm-block-size+
                 (+ data-page-base (* file-page +vlm-blocks-per-data-page+))))
        (toff (* +vlm-block-size+
                 (+ tags-page-base (* file-page +vlm-blocks-per-tags-page+)))))
    (dotimes (i count qv)
      (set-q qv i (aref buf (+ toff i)) (le32 buf (+ doff (* 4 i)))))))

;;; Writing

(defun vlod-entry-file-pages (entry)
  "VLM file pages spanned by a :data-pages entry (CanonicalizeVLMLoadMapEntries)."
  (ceiling (map-entry-count entry) +vlm-page-size-qs+))

(defun vlod-file-size (model)
  "Mimic WriteVLMWorldFileHeader's ftruncate: scan the wired map from the
end for the last :data-pages entry; file spans dataPageBase +
(filepage + floor(count/8192) + 1) data-page block groups."
  (let ((last (find +op-data-pages+ (reverse (world-model-wired-map model))
                    :key #'map-entry-opcode)))
    (if (null last)
        ;; No data pages: just the header region
        (* (world-model-tags-page-base model) +vlm-block-size+)
        (* +vlm-block-size+
           (+ (world-model-data-page-base model)
              (* (+ (map-entry-data-data last)
                    (floor (map-entry-count last) +vlm-page-size-qs+)
                    1)
                 +vlm-blocks-per-data-page+))))))

(defun write-vlod (model)
  (let* ((size (if (plusp (world-model-file-size model))
                   (world-model-file-size model)
                   (vlod-file-size model)))
         (buf (make-array size :element-type '(unsigned-byte 8)
                               :initial-element 0))
         (dpb (world-model-data-page-base model))
         (tpb (world-model-tags-page-base model)))
    (replace buf (world-model-header-bytes model))
    (dolist (e (world-model-wired-map model))
      (when (= (map-entry-opcode e) +op-data-pages+)
        (let* ((fp (map-entry-data-data e))
               (qv (map-entry-payload e))
               (doff (* +vlm-block-size+ (+ dpb (* fp +vlm-blocks-per-data-page+))))
               (toff (* +vlm-block-size+ (+ tpb (* fp +vlm-blocks-per-tags-page+)))))
          (dotimes (i (qvec-length qv))
            (multiple-value-bind (tag data) (qref qv i)
              (setf (aref buf (+ toff i)) tag
                    (le32 buf (+ doff (* 4 i))) data))))))
    buf))

(defun assign-vlod-layout (model)
  "Assign file page numbers and page bases per CanonicalizeVLMLoadMapEntries.
All :data-pages entries must be 8192-Q aligned (the builder should have
converted unaligned data to :constant entries already)."
  (let ((page 0))
    (dolist (e (world-model-wired-map model))
      (when (= (map-entry-opcode e) +op-data-pages+)
        (unless (zerop (mod (map-entry-address e) +vlm-page-size-qs+))
          (error "Unaligned :data-pages entry at #x~X" (map-entry-address e)))
        (setf (map-entry-data-data e) page)
        (incf page (vlod-entry-file-pages e))))
    (let* ((nqs (header-q-count (length (world-model-wired-map model)) 0
                                +vlm-first-map-q+))
           (blocks (ceiling (* (ivory-pages-for-qs nqs) +ivory-page-size-bytes+)
                            +vlm-block-size+)))
      (when (> blocks +vlm-maximum-header-blocks+)
        (error "Load map too large for VLM world header (~D blocks)" blocks))
      (setf (world-model-tags-page-base model) blocks
            (world-model-data-page-base model)
            (+ blocks (* +vlm-blocks-per-tags-page+ page))))
    model))
