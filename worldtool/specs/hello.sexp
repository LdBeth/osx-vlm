;;; hello.sexp -- minimal bootable Ivory world.
;;; The startup "function" is a single packed instruction word holding two
;;; `halt 0` halfwords (opcode 0o57): booting lands in TrapMode_FEP where
;;; halt is legal, so the VLM exits cleanly with HaltReason_Halted.
;;; VMA 0xF8020000 is FEP space, clear of the debugger footprint
;;; (0xF8006000-0xF8017100), boot stack, trap vectors, and comm areas.
(:format :ilod
 :version-q #x410040
 :entries
 ((:data-pages :vma #xF8020000
   :qs ((0 50 #xF000BC00)      ; cdr 0, packed-pair type: (halt 0 . halt 0)
        (1 0 0)))              ; cdr 1: end of compiled code
  (:constant :vma #xF8041002 :q (0 28 #xF8020000))   ; FEPComm fepStartup
  (:constant :vma #xF8041102 :q (0 28 #xF8020000))   ; SystemComm systemStartup
  (:constant :vma #xF8041000 :q (0 8 #x149))))       ; fepVersionNumber (as debugger)
