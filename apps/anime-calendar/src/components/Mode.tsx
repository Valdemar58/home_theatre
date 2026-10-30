"use client";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { FORM_LABELS, type FranchiseForm as Mode } from "@/lib/franchise";
import { cx } from "./ui";

// Режим сайта «Аниме / Манга / Ранобэ» (TASKS 5.10, как AniLib / MangaLib / RanobeLib): переключатель в шапке.
// Страница объявляет свой режим (книга — по виду), страница франшизы забирает переключатель себе — он выбирает,
// какие формы показать. На остальных страницах выбор ведёт в раздел режима.

export type { Mode };
export const MODES: Mode[] = ["anime", "manga", "novel"];
export const MODE_TONE: Record<Mode, string> = { anime: "tone-special", manga: "tone-warning", novel: "tone-positive" };

const BOOK_MODE_KEY = "book-mode";
type Takeover = { value: Mode | null; pick: (m: Mode) => void };
type Ctx = { page: Mode | null; setPage: (m: Mode | null) => void; takeover: Takeover | null; setTakeover: (t: Takeover | null) => void };
const ModeCtx = createContext<Ctx | null>(null);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [page, setPage] = useState<Mode | null>(null);
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  const value = useMemo(() => ({ page, setPage, takeover, setTakeover }), [page, takeover]);
  return <ModeCtx.Provider value={value}>{children}</ModeCtx.Provider>;
}

/** Последний выбранный режим книг (манга или ранобэ) — куда вести из аниме. */
export function bookMode(): Mode {
  try { return localStorage.getItem(BOOK_MODE_KEY) === "novel" ? "novel" : "manga"; } catch { return "manga"; }
}
const rememberBookMode = (m: Mode) => {
  try { if (m !== "anime") localStorage.setItem(BOOK_MODE_KEY, m); } catch { /* без хранилища — по умолчанию манга */ }
};

/** Страница объявляет свой режим (книга — манга или ранобэ). */
export function useDeclareMode(mode: Mode | null) {
  const ctx = useContext(ModeCtx);
  const set = ctx?.setPage;
  useEffect(() => {
    if (!set || !mode) return;
    set(mode);
    rememberBookMode(mode);
    return () => set(null);
  }, [set, mode]);
}

/** Страница забирает переключатель себе (франшиза: какие формы показать; null — все). */
export function useModeTakeover(value: Mode | null, pick: (m: Mode) => void) {
  const set = useContext(ModeCtx)?.setTakeover;
  useEffect(() => {
    if (!set) return;
    set({ value, pick });
    return () => set(null);
  }, [set, value, pick]);
}

const isBookPath = (p: string) => p.startsWith("/manga");

export function ModeSwitch({ className, wide }: { className?: string; wide?: boolean }) {
  const ctx = useContext(ModeCtx);
  const pathname = usePathname();
  const router = useRouter();
  const [stored, setStored] = useState<Mode>("manga");
  useEffect(() => setStored(bookMode()), [pathname]);
  const current: Mode | null = ctx?.takeover ? ctx.takeover.value : ctx?.page ?? (isBookPath(pathname) ? stored : "anime");
  const pick = (m: Mode) => {
    rememberBookMode(m);
    if (ctx?.takeover) return ctx.takeover.pick(m);
    if (m === current) return;
    if (m === "anime") router.push("/browse");
    else router.push(`/manga?kind=${m}`);
  };
  return (
    <nav aria-label="Режим" className={cx("flex shrink-0 gap-1 rounded-full bg-gray-800/70 p-1 ring-1 ring-gray-700", wide && "grid grid-cols-3 rounded-xl", className)}>
      {MODES.map((m) => (
        <button key={m} type="button" onClick={() => pick(m)} aria-pressed={current === m}
          className={cx("rounded-full px-3 py-1.5 text-sm font-medium transition lg:px-4", wide && "rounded-lg py-2", MODE_TONE[m],
            current === m ? "solid" : "tone-text hover:bg-gray-700/60")}>
          {FORM_LABELS[m]}
        </button>
      ))}
    </nav>
  );
}
