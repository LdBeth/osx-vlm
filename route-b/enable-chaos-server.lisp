;;; -*- Mode: LISP; Syntax: Common-Lisp; Package: CL-USER; Base: 10 -*-
;;;
;;; Route B: make this (warm, user-site) world the chaos #o401 file server
;;; the QLD guest knows as DIS-SYS-HOST.
;;;
;;; The namespace edits below are IN-CORE ONLY (update-object-permanently
;;; with local=t): a cold boot forgets them.  Re-load this file after every
;;; cold boot of the server world, from a Lisp Listener:
;;;
;;;   (load "COSTUMEPARTY:/Users/ldbeth/Public/symbolics/route-b/enable-chaos-server.lisp")
;;;
;;; (The NFS export covers only /Users/ldbeth/Public/symbolics, so the repo
;;; original at linux-vlm/route-b/ is staged there; re-copy after edits.)
;;;
;;; Background (de-risk session 2026-08-01): a warm Genera ignores the
;;; CHAOS|nnn network spec in the .VLM file entirely -- the chaos address
;;; lives in the namespace, and the Finale namespace had no CHAOS network
;;; object at all.  These forms are the namespace editor's own idiom,
;;; lifted from NET:SET-SITE (sys:network;distribution.lisp).
;;;
;;; The serving tree lives at ETHERNAL:>sys>**> (full mirror of the
;;; >rel-8-5>sys>**> master plus the 415 host-side-only files, built
;;; 2026-08-01); QLD's baked translations ask for DIS-SYS-HOST:>sys>**>,
;;; and the QLD build log goes to DIS-SYS-HOST:>wobbly>...>.

(defun route-b-enable-chaos-server (&optional (address "401"))
  "Give the local host chaos ADDRESS and advertise NFILE :FILE service.
Idempotent; finishes with a general network reset (which drops any
telnet connection this is typed over -- reconnect afterwards)."
  (let ((chaos (neti:find-object-named :network "CHAOS" nil)))
    ;; 1. A CHAOS network object, created if the site never had one.
    ;; (find-object-named's error-p DEFAULTS TO T -- always pass nil here,
    ;; or a genuinely-missing object signals instead of returning NIL.)
    (unless chaos
      (neti:update-object-permanently :network net:*namespace*
                                      (neti:parse-name "CHAOS" nil net:*namespace*)
                                      '(:type :chaos)
                                      t)
      (setq chaos (neti:find-object-named :network "CHAOS")))
    ;; 2. Local host: chaos address + :FILE CHAOS NFILE service.
    (multiple-value-bind (name plist)
        (send net:*local-host* :namespace-view net:*namespace*)
      (let ((changed nil))
        (unless (cl:assoc chaos (cl:getf plist :address))
          (push (list chaos address) (cl:getf plist :address))
          (setq changed t))
        (unless (cl:member '(:file :chaos :nfile) (cl:getf plist :service)
                           :test #'cl:equal)
          (push '(:file :chaos :nfile) (cl:getf plist :service))
          (setq changed t))
        (when changed
          (neti:update-object-permanently :host net:*namespace* name plist t))))
    ;; 3. Make the running network layer believe it.
    (neti:general-network-reset)
    (format t "~&Chaos ~A enabled; NFILE service advertised.~%" address)))

(defun route-b-point-dis-sys-host-at-401 ()
  "For DIST-WORLD TEST CLIENTS only (the stock dist namespace has
DIS-SYS-HOST at #o24620, whose RFCs fall back to broadcast and vanish).
The fresh QLD cold world already bakes DIS-SYS-HOST at #o401 -- it does
NOT need this."
  (let ((h (net:parse-host "DIS-SYS-HOST"))
        (chaos (neti:find-object-named :network "CHAOS" nil)))
    (multiple-value-bind (name plist) (send h :namespace-view net:*namespace*)
      (setf (cl:getf plist :address) (list (list chaos "401")))
      (neti:update-object-permanently :host net:*namespace* name plist t))
    (format t "~&DIS-SYS-HOST repointed to chaos 401.~%")))

;; Loading this file on the server world does the server-side setup.
(route-b-enable-chaos-server)
