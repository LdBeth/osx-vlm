;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: CL-USER; Base: 10 -*-
;;;
;;; Route B: Lisp MINI cold-load file server, running on the server VLM
;;; ("A", chaos #o401) next to the stock NFILE server.  It replaced the
;;; in-emulator C MINI server (life-support/mini-server.c, deleted
;;; 2026-08-07) and is now the only MINI server: the guest runs with no
;;; GENERA_SYS_ROOT at all, and every frame to 401 -- MINI and NFILE
;;; alike -- crosses the vmnet wire to this machine.
;;;
;;; Wire contract (reconstructed from SYS:IO;LMINI, same as the C server;
;;; all client constants octal):
;;;   - Client RFCs contact "MINI" (RFC string "MINI LISPM ").  Window 1,
;;;     STS-ack per controlled packet -- the real NCP handles all of that.
;;;   - Requests are packets of opcode 0200 (character) / 0201 (binary)
;;;     whose data is a logical pathname, verbatim, e.g.
;;;     "SYS: SYS; MINI-ALISTS.VBIN.NEWEST" (spaces optional).
;;;   - Reply 0202 (won) / 0203 (lost): truename + #o215 (Lispm Return) +
;;;     32-bit universal time as four raw bytes, little-endian (low
;;;     16-bit half first, each half low byte first).  A lost reply
;;;     echoes the request string with a zero date.  Those four RAW bytes
;;;     are the Genera 8.5 delta from the CADR-era MINI servers, which
;;;     sent a textual date here.
;;;   - File data: opcode 0200 packets (character files, Lispm charset
;;;     bytes verbatim) or 0300 packets (binary files, 16-bit words),
;;;     then a chaos EOF (014).  The connection persists across files.
;;;
;;; Below the NCP, for anyone who has to read frames on the wire (this
;;; server never sees this layer -- the retired C server built it by hand):
;;;   - Chaos-over-Ethernet is ethertype 0x0804, with its own chaos ARP at
;;;     ethertype 0x0806 (hardware type 1, protocol type 0x0804).
;;;   - The chaos header is 8 little-endian 16-bit words: opcode<<8,
;;;     length (low 12 bits, in bytes), dest, dest-index, source,
;;;     source-index, packet#, ack#.  Data starts at byte 16 and is at
;;;     most 488 bytes.
;;;
;;; The serving tree is ETHERNAL:>sys>**> (the full QLD serving copy WITH
;;; vbins) -- NOT this world's SYS: translation, which points at the
;;; vbin-pruned >rel-8-5>sys> master.
;;;
;;; Load (from the staged NFS copy) and it starts itself:
;;;   (load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/mini-server.lisp")

(defvar *mini-serving-root* "ETHERNAL:>sys>"
  "LMFS directory the SYS: host in MINI requests translates to.")

(defvar *mini-verbose* t
  "Log each request to the console.")

(defvar *mini-server-process* nil)

(defvar *mini-log* (make-string-output-stream)
  "Background-process log; read with (mini-log).  Never *terminal-io* --
background typeout would block the server process.")

(defun mini-log ()
  (get-output-stream-string *mini-log*))

(defparameter *mini-data-bytes-per-pkt* 488)

;;; "SYS: D1; D2; NAME.TYPE.VERSION" -> (values ok dirs name type version)
;;; dirs/name/type are strings (type may be NIL), version a string or NIL.
;;; OK is NIL if the request is not a SYS: pathname or fails to parse.
(defun mini-parse-request (request)
  (let ((colon (position #\: request)))
    (when (and colon
               (string-equal (string-trim " " (subseq request 0 colon))
                                "SYS"))
      (let ((tokens nil)
            (start (1+ colon)))
        (loop
          (let* ((semi (position #\; request :start start))
                 (token (string-trim " " (subseq request start semi))))
            (when (zerop (length token))
              (return-from mini-parse-request nil))
            (push token tokens)
            (if semi
                (setq start (1+ semi))
                (return))))
        (setq tokens (nreverse tokens))
        (let* ((file (first (last tokens)))
               (dirs (butlast tokens))
               (dot1 (position #\. file))
               (name (if dot1 (subseq file 0 dot1) file))
               (rest (and dot1 (subseq file (1+ dot1))))
               (dot2 (and rest (position #\. rest)))
               (type (if dot2 (subseq rest 0 dot2) rest))
               (version (and dot2 (subseq rest (1+ dot2)))))
          (when (zerop (length name))
            (return-from mini-parse-request nil))
          (values t dirs name type version))))))

;;; Target pathname in the serving tree.  A missing type defaults by
;;; transfer mode (the C server's rule); version defaults to newest.
(defun mini-target-pathname (dirs name type version binary-p)
  (fs:parse-pathname
    (format nil "~A~{~A>~}~A.~A.~A"
               *mini-serving-root* dirs name
               (or type (if binary-p "VBIN" "LISP"))
               (or version "newest"))))

;;; Truename for the 0202 reply: the canonical spaced SYS: form the cold
;;; world can parse ("SYS: SYS; MINI-ALISTS.VBIN.42"), never an ETHERNAL:
;;; LMFS path (the cold world has no such host).
(defun mini-truename-string (dirs name type actual-truename)
  (string-upcase
    (format nil "SYS:~{ ~A;~} ~A.~A.~D"
               dirs name type
               (let ((v (send actual-truename :version)))
                 (if (integerp v) v 1)))))

(defun mini-send-answer (conn won-p text universal-time)
  (let ((pkt (chaos::get-pkt)))
    (chaos::set-pkt-string
      pkt text
      (string (code-char #o215))
      (string (code-char (ldb (byte 8 0) universal-time)))
      (string (code-char (ldb (byte 8 8) universal-time)))
      (string (code-char (ldb (byte 8 16) universal-time)))
      (string (code-char (ldb (byte 8 24) universal-time))))
    (chaos::send-pkt conn pkt (if won-p #o202 #o203))))

(defun mini-send-character-file (conn stream)
  (loop
    (multiple-value-bind (buffer start limit)
        (send stream :read-input-buffer)
      (when (null buffer)
        (return))
      (loop while (< start limit)
               do (let* ((n (min (- limit start) *mini-data-bytes-per-pkt*))
                         (pkt (chaos::get-pkt))
                         (str (chaos::pkt-string pkt)))
                    (setf (fill-pointer str) n)
                    (copy-array-portion buffer start (+ start n) str 0 n)
                    (setf (chaos::pkt-nbytes pkt) n)
                    (chaos::send-pkt conn pkt #o200)
                    (incf start n)))
      (send stream :advance-input-buffer))))

(defun mini-send-binary-file (conn stream)
  (let ((words-per-pkt (floor *mini-data-bytes-per-pkt* 2)))
    (loop
      (multiple-value-bind (buffer start limit)
          (send stream :read-input-buffer)
        (when (null buffer)
          (return))
        (loop while (< start limit)
                 do (let* ((n (min (- limit start) words-per-pkt))
                           (pkt (chaos::get-pkt)))
                      (copy-array-portion buffer start (+ start n)
                                          pkt chaos::first-data-word-in-pkt
                                          (+ chaos::first-data-word-in-pkt n))
                      (setf (fill-pointer (chaos::pkt-string pkt)) (* 2 n))
                      (setf (chaos::pkt-nbytes pkt) (* 2 n))
                      (chaos::send-pkt conn pkt #o300)
                      (incf start n)))
        (send stream :advance-input-buffer)))))

(defun mini-send-eof (conn)
  (let ((pkt (chaos::get-pkt)))
    (setf (chaos::pkt-nbytes pkt) 0)
    (chaos::send-pkt conn pkt chaos::eof-op)))

(defun mini-serve-request (conn request binary-p)
  (multiple-value-bind (ok dirs name type version)
      (mini-parse-request request)
    (let ((stream nil))
      (unwind-protect
          (progn
            (when ok                    ; parsed as a SYS: pathname
              (condition-case (err)
                  (setq stream
                        (open (mini-target-pathname dirs name type version binary-p)
                                 :direction :input
                                 :element-type (if binary-p
                                                   '(unsigned-byte 16)
                                                   'character)))
                (fs:file-error
                  (when *mini-verbose*
                    (format *mini-log* "~&MINI: open failed for ~A: ~A~%" request err)))))
            (cond
              (stream
               (let* ((truename (send stream :truename))
                      (props (condition-case ()
                                 (fs:file-properties truename)
                               (fs:file-error nil)))
                      (date (or (and (consp props)
                                     (getf (cdr props) :creation-date))
                                0))
                      (reply (mini-truename-string
                               dirs name
                               (or type (if binary-p "VBIN" "LISP"))
                               truename)))
                 (when *mini-verbose*
                   (format *mini-log* "~&MINI: serving ~A~%" (send truename :string-for-printing)))
                 (mini-send-answer conn t reply date)
                 (if binary-p
                     (mini-send-binary-file conn stream)
                     (mini-send-character-file conn stream))
                 (mini-send-eof conn)))
              (t
               (when (and *mini-verbose* (null ok))
                 (format *mini-log* "~&MINI: unparseable request ~S~%" request))
               (mini-send-answer conn nil request 0))))
        (when stream (close stream))))))

(defun mini-serve-connection (conn)
  (loop
    (let* ((pkt (chaos::get-next-pkt conn))
           (opcode (chaos::pkt-opcode pkt)))
      (unwind-protect
          (case opcode
            (#o200 (mini-serve-request conn (string (chaos::pkt-string pkt)) nil))
            (#o201 (mini-serve-request conn (string (chaos::pkt-string pkt)) t))
            ((#o003 #o011)              ; CLS / LOS: client is gone
             (return))                  ; pkt freed by the cleanup below
            (otherwise
              (when *mini-verbose*
                (format *mini-log* "~&MINI: ignoring opcode ~O~%" opcode))))
        (chaos::return-pkt pkt)))))

;;; One process per accepted connection.  The listener must never block
;;; on serving: a client that vanishes without CLS (a rebooted QLD guest,
;;; a killed test conn) leaves its service process parked in get-next-pkt
;;; forever, and with a single-process design that wedged the whole
;;; server (live-debugged 2026-08-01: "did not respond to a MINI
;;; request" on the NEXT connection).  Parked processes from dead
;;; connections are a deliberate, bounded leak (one per guest boot).
;;;
;;; The catch-all matters: fs:file-error covers only the OPEN, and
;;; pathname parse conditions aren't even fs:file-errors.  Anything that
;;; escaped here would park this process in the debugger WITHOUT
;;; unwinding -- connection, LMFS stream, and pkt all leaked, client
;;; blocked forever, nothing in (mini-log).  So: log, CLS the client,
;;; and let the cleanups tear the connection down.
(defun mini-serve-connection-top (conn)
  (unwind-protect
      (condition-case (err)
          (mini-serve-connection conn)
        (sys:network-error
          (when *mini-verbose*
            (format *mini-log* "~&MINI: connection ended: ~A~%" err)))
        (error
          (format *mini-log* "~&MINI: error serving connection: ~A~%" err)
          (condition-case () (chaos::close-conn conn "MINI server error")
            (error nil))))
    (condition-case () (chaos::remove-conn conn) (error nil))))

(defun mini-server-top-level ()
  (loop for n from 1
        do (let ((conn nil))
             (condition-case (err)
                 (progn
                   (setq conn (chaos::listen "MINI"))
                   (chaos::accept conn)
                   (when *mini-verbose*
                     (format *mini-log* "~&MINI: connection ~D accepted~%" n))
                   (process-run-function (format nil "MINI Service ~D" n)
                                         #'mini-serve-connection-top conn)
                   (setq conn nil))     ; now owned by the service process
               (sys:network-error
                 (when *mini-verbose*
                   (format *mini-log* "~&MINI: listen/accept failed: ~A~%" err))
                 (when conn
                   (condition-case () (chaos::remove-conn conn) (error nil))))))))

(defun start-mini-server ()
  (when *mini-server-process*
    (send *mini-server-process* :kill)
    (setq *mini-server-process* nil))
  (setq *mini-server-process*
        (process-run-function "MINI Server" #'mini-server-top-level))
  (format t "~&MINI server listening (contact MINI, serving ~A).~%"
             *mini-serving-root*))

(start-mini-server)
