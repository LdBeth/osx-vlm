;;; Negative control: startup slots point at zeroed Qs (0xF8020100, inside
;;; the loaded page but past the code).  Execution should NOT halt cleanly:
;;; expect a non-zero exit / error report, not the silent HaltReason_Halted.
(:format :ilod
 :version-q #x410040
 :entries
 ((:data-pages :vma #xF8020000
   :qs ((0 50 #xF000BC00)
        (1 0 0)))
  (:constant :vma #xF8041002 :q (0 28 #xF8020100))   ; points into zero fill
  (:constant :vma #xF8041102 :q (0 28 #xF8020100))
  (:constant :vma #xF8041000 :q (0 8 #x149))))
