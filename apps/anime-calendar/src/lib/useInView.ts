"use client";
import { useEffect, useRef } from "react";

/**
 * Вызвать onEnter, когда элемент приближается к области видимости (бесконечная лента).
 * Пока условие enabled ложно (идёт загрузка, страниц больше нет) — не наблюдаем.
 */
export function useInView<T extends Element>(onEnter: () => void, enabled: boolean, margin = "600px") {
  const ref = useRef<T>(null);
  const cb = useRef(onEnter);
  cb.current = onEnter;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && cb.current(), { rootMargin: `0px 0px ${margin} 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, margin]);
  return ref;
}
