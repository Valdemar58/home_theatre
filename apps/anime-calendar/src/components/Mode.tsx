"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

// Разделы меню, у которых своё содержимое в каждом режиме
export type Section = "calendar" | "catalog" | "lists";
const ANIME_HREF: Record<Section, string> = { calendar: "/calendar", catalog: "/browse", lists: "/lists" };
const BOOK_PATH: Record<Section, string> = { calendar: "/manga/releases", catalog: "/manga", lists: "/manga/list" };

/** Адрес раздела в режиме: аниме — свои страницы, книги — раздел /manga с видом. */
export const sectionHref = (s: Section, m: Mode) => (m === "anime" ? ANIME_HREF[s] : `${BOOK_PATH[s]}?kind=${m}`);

/** Раздел по адресу (страница книги и прочие — без раздела). */
export function sectionOf(pathname: string): Section | null {
  for (const s of ["calendar", "lists", "catalog"] as Section[]) {
    if (pathname === BOOK_PATH[s] || pathname.startsWith(ANIME_HREF[s])) return s;
  }
  return null;
}

/**
 * Текущий режим. Для переключателя франшиза, забравшая его, отдаёт свой фильтр (null — все формы); для меню
 * (nav) — режим страницы.
 */
export function useMode(nav = false): Mode | null {
  const ctx = useContext(ModeCtx);
  const pathname = usePathname();
  const [stored, setStored] = useState<Mode>("manga");
  useEffect(() => setStored(bookMode()), [pathname]);
  if (ctx?.takeover && !nav) return ctx.takeover.value;
  return ctx?.page ?? (isBookPath(pathname) ? stored : "anime");
}

/** Вид книг раздела из адреса (?kind=манга или ранобэ), без него — последний выбранный; страница объявляет режим. */
export function useBookKind(): "manga" | "novel" {
  const param = useSearchParams().get("kind");
  const [stored, setStored] = useState<"manga" | "novel">("manga");
  useEffect(() => setStored(bookMode() === "novel" ? "novel" : "manga"), []);
  const kind = param === "novel" || param === "manga" ? param : stored;
  useDeclareMode(kind);
  return kind;
}

export function ModeSwitch({ className, wide }: { className?: string; wide?: boolean }) {
  const ctx = useContext(ModeCtx);
  const pathname = usePathname();
  const router = useRouter();
  const current = useMode();
  const pick = (m: Mode) => {
    rememberBookMode(m);
    if (ctx?.takeover) return ctx.takeover.pick(m);
    if (m === current) return;
    // Тот же раздел в другом режиме; со страницы тайтла — в каталог
    router.push(sectionHref(sectionOf(pathname) ?? "catalog", m));
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
