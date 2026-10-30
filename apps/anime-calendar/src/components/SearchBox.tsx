"use client";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, useList } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { FORMAT_LABELS, LIST_LABELS, label } from "@/lib/labels";
import { displayTitle, secondaryTitle } from "@/lib/schedule";
import type { MediaLite } from "@/lib/types";
import { KIND_LABELS as BOOK_KIND_LABELS, type BookLite } from "@/lib/books";
import { entryKey, STATUS_COLORS } from "./ListControl";
import { useMode } from "./Mode";
import { cx, Spinner } from "./ui";

// Строка поиска в шапке: подсказки по мере ввода (по-русски тоже), стрелки/Enter/Esc.
// Enter без выбранной подсказки — полный поиск в каталоге. Что искать — по режиму: аниме, манга или ранобэ.

type Hit = { id: number; href: string; title: string; alt: string | null; cover: string | null; color: string | null; meta: string; media?: MediaLite };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchBox() {
  const router = useRouter();
  const { byId } = useList();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLFormElement>(null);
  const dq = useDebounced(q.trim(), 350);
  const mode = useMode(true) ?? "anime";

  const { data, isFetching } = useQuery({
    queryKey: ["suggest", mode, dq],
    queryFn: async (): Promise<Hit[]> => {
      if (mode === "anime") {
        return (await api<{ media: MediaLite[] }>(`/api/search?q=${encodeURIComponent(dq)}`)).media.map((m) => ({
          id: m.id, href: `/anime/${m.id}`, title: displayTitle(m.title), alt: secondaryTitle(m.title), cover: m.coverImage.large, color: m.coverImage.color,
          meta: [m.seasonYear, label(FORMAT_LABELS, m.format)].filter(Boolean).join(" · "), media: m,
        }));
      }
      return (await api<{ books: BookLite[] }>(`/api/books/search?q=${encodeURIComponent(dq)}&kind=${mode}`)).books.slice(0, 8).map((b) => ({
        id: b.id, href: `/manga/${b.id}`, title: b.title.ru || b.title.romaji || b.title.english || String(b.id),
        alt: b.title.ru ? b.title.romaji : null, cover: b.coverImage.large, color: b.coverImage.color,
        meta: [b.year, BOOK_KIND_LABELS[b.kind]].filter(Boolean).join(" · "),
      }));
    },
    enabled: dq.length >= 2,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const items = dq.length >= 2 ? (data ?? []) : [];

  // Клик мимо — закрыть
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const close = () => { setOpen(false); setActive(-1); };
  const go = (href: string) => { close(); router.push(href); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (active >= 0 && items[active]) return go(items[active].href);
    if (q.trim()) go(mode === "anime" ? `/browse?q=${encodeURIComponent(q.trim())}` : `/manga?kind=${mode}&q=${encodeURIComponent(q.trim())}`);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (!items.length || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    setOpen(true);
    setActive((a) => (e.key === "ArrowDown" ? (a + 1) % items.length : (a <= 0 ? items.length : a) - 1));
  };

  const show = open && q.trim().length >= 2;
  return (
    <form ref={box} onSubmit={submit} className="relative ml-auto w-full max-w-md lg:ml-0">
      <label className="relative block">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={mode === "anime" ? "Поиск аниме" : mode === "novel" ? "Поиск ранобэ" : "Поиск манги"}
          role="combobox"
          aria-expanded={show}
          aria-controls="search-suggest"
          className="w-full rounded-full border border-gray-700 bg-gray-800/80 py-2 pl-10 pr-9 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        {isFetching && q.trim().length >= 2 && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
      </label>

      {show && (
        <div id="search-suggest" role="listbox"
          className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl bg-gray-800 shadow-2xl ring-1 ring-gray-700">
          {items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-400">{isFetching || dq !== q.trim() ? "Ищу…" : "Ничего не нашлось"}</p>
          ) : (
            items.map((m, i) => {
              const entry = m.media ? byId.get(m.id) : undefined;
              const alt = m.alt;
              return (
                <Link key={m.id} href={m.href} role="option" aria-selected={i === active}
                  onClick={close} onMouseEnter={() => setActive(i)}
                  className={cx("flex items-center gap-3 px-3 py-2", i === active && "bg-gray-700/70")}>
                  <span className="h-14 w-10 shrink-0 overflow-hidden rounded bg-gray-700" style={{ backgroundColor: m.color ?? undefined }}>
                    {m.cover && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgSrc(m.cover, "thumb")} alt="" className="h-full w-full object-cover" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white">{m.title}</span>
                    {alt && <span className="block truncate text-xs text-gray-400">{alt}</span>}
                    <span className="block text-xs text-gray-500">{m.meta}</span>
                  </span>
                  {entry && (
                    <span className={cx("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold text-white", STATUS_COLORS[entryKey(entry)])}>
                      {LIST_LABELS[entryKey(entry)]}
                    </span>
                  )}
                </Link>
              );
            })
          )}
          <button type="submit" onMouseEnter={() => setActive(-1)}
            className="block w-full border-t border-gray-700 px-4 py-2.5 text-left text-sm text-indigo-300 hover:bg-gray-700/70">
            Все результаты по «{q.trim()}» →
          </button>
        </div>
      )}
    </form>
  );
}
