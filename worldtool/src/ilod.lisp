;;; -*- Mode: Lisp; Package: WORLDTOOL -*-
;;; Ivory (.ilod) world file reader/writer.
;;; Reference: src/world_tools.c OpenWorldFile/ReadLoadMap/IvoryLoadMapData,
;;; ReadIvoryWorldFileQ (packing).  The whole file is Ivory-packed pages.

(in-package #:worldtool)

(defun parse-map-entries (buf first-map-q n)
  "Parse N load-map entries starting at absolute Q FIRST-MAP-Q."
  (loop for i below n
        for q = (+ first-map-q (* 3 i))
        collect
        (multiple-value-bind (atag adata) (ivory-read-q buf q)
          (multiple-value-bind (otag odata) (ivory-read-q buf (+ q 1))
            (multiple-value-bind (dtag ddata) (ivory-read-q buf (+ q 2))
              (make-map-entry :address adata :address-tag atag
                              :opcode (ldb (byte 8 24) odata)
                              :count (ldb (byte 24 0) odata)
                              :op-tag otag
                              :data-tag dtag :data-data ddata))))))

(defun ilod-payload-pages (entry)
  "Number of whole Ivory pages occupied by ENTRY's payload."
  (ivory-pages-for-qs (map-entry-count entry)))

(defun read-ilod (buf)
  (multiple-value-bind (nil-tag nwired) (ivory-read-q buf +ivory-wired-count-q+)
    (declare (ignore nil-tag))
    (multiple-value-bind (nil-tag nunwired) (ivory-read-q buf +ivory-unwired-count-q+)
      (declare (ignore nil-tag))
      (let* ((nqs (header-q-count nwired nunwired +ivory-first-map-q+))
             (wired (parse-map-entries buf +ivory-first-map-q+ nwired))
             (unwired (parse-map-entries buf (+ +ivory-first-map-q+ (* 3 nwired))
                                         nunwired))
             (entries (append wired unwired))
             (data-entries (remove +op-data-pages+ entries
                                   :key #'map-entry-opcode :test #'/=))
             ;; Header region: everything before the first payload page
             (header-pages (if data-entries
                               (reduce #'min data-entries
                                       :key #'map-entry-data-data)
                               (ivory-pages-for-qs nqs))))
        (dolist (e data-entries)
          (setf (map-entry-payload e)
                (ivory-read-qvec buf (* (map-entry-data-data e)
                                        +ivory-page-size-qs+)
                                 (map-entry-count e))))
        (make-world-model :format :ilod
                          :header-bytes (subseq buf 0 (* header-pages
                                                         +ivory-page-size-bytes+))
                          :wired-map wired
                          :unwired-map unwired
                          :file-size (length buf))))))

(defun write-ilod (model)
  "Serialize MODEL to a byte vector in .ilod format."
  (let* ((header (world-model-header-bytes model))
         (header-pages (floor (length header) +ivory-page-size-bytes+))
         (entries (append (world-model-wired-map model)
                          (world-model-unwired-map model)))
         (data-entries (remove +op-data-pages+ entries
                               :key #'map-entry-opcode :test #'/=))
         (npages (reduce #'max
                         (mapcar (lambda (e)
                                   (+ (map-entry-data-data e)
                                      (ilod-payload-pages e)))
                                 data-entries)
                         :initial-value header-pages))
         (buf (make-array (* npages +ivory-page-size-bytes+)
                          :element-type '(unsigned-byte 8)
                          :initial-element 0)))
    (replace buf header)
    (dolist (e data-entries)
      (ivory-write-qvec buf (* (map-entry-data-data e) +ivory-page-size-qs+)
                        (map-entry-payload e)))
    buf))

(defun synthesize-map-qs (model first-map-q)
  "Fill MODEL's header-bytes map region from its map-entry lists."
  (let ((header (world-model-header-bytes model))
        (q first-map-q))
    (dolist (e (append (world-model-wired-map model)
                       (world-model-unwired-map model)))
      (ivory-write-q header q (map-entry-address-tag e) (map-entry-address e))
      (ivory-write-q header (+ q 1) (map-entry-op-tag e)
                     (logior (ash (map-entry-opcode e) 24) (map-entry-count e)))
      (ivory-write-q header (+ q 2) (map-entry-data-tag e) (map-entry-data-data e))
      (incf q 3))
    header))

(defun assign-ilod-file-pages (model)
  "Assign sequential file page numbers to :data-pages entries, starting
after the header pages.  Returns the number of header pages."
  (let* ((nwired (length (world-model-wired-map model)))
         (nunwired (length (world-model-unwired-map model)))
         (nqs (header-q-count nwired nunwired +ivory-first-map-q+))
         (header-pages (ivory-pages-for-qs nqs))
         (page header-pages))
    (dolist (e (append (world-model-wired-map model)
                       (world-model-unwired-map model)))
      (when (= (map-entry-opcode e) +op-data-pages+)
        (setf (map-entry-data-data e) page)
        (incf page (ilod-payload-pages e))))
    header-pages))
