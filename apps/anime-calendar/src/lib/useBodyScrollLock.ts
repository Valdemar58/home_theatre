"use client";
import { useEffect } from "react";

let locks = 0;
let previous = "";

/** Nested sheets and dialogs must not unlock the page while another is open. */
export function useBodyScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) return;
    if (locks++ === 0) {
      previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      if (--locks === 0) document.body.style.overflow = previous;
    };
  }, [open]);
}
