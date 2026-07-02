;;; Negative control: startup slots carry tag #x9C (cdr 2 | CompiledFunction)
;;; instead of exactly #x1C.  IvoryProcessorSystemStartup compares the full
;;; 8-bit tag, so boot must fail with "Unable to start the VLM."
(:format :ilod
 :version-q #x410040
 :entries
 ((:data-pages :vma #xF8020000
   :qs ((0 50 #xF000BC00)
        (1 0 0)))
  (:constant :vma #xF8041002 :q (2 28 #xF8020000))   ; tag 0x9C: cdr bits set
  (:constant :vma #xF8041102 :q (2 28 #xF8020000))
  (:constant :vma #xF8041000 :q (0 8 #x149))))
