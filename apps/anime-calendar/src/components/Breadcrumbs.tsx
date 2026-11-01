"use client";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

// Путь страницы: «Тайтл › Персонажи › Римуру». Страницы сюжета тайтла запоминают тайтл на время вкладки, чтобы
// страница персонажа (адрес без тайтла: персонаж общий для франшизы) вела обратно в тот сезон, откуда пришли.

/** options — соседние варианты звена (сезоны, где есть персонаж): звено раскрывается списком */
export type Crumb = { label: string; href?: string; options?: { label: string; href: string; note?: string | null; current?: boolean }[] };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Путь" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-gray-400">
        {items.map((c, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-gray-600" />}
            {c.options && c.options.length > 1 ? <CrumbMenu c={c} />
              : c.href && i < items.length - 1
              ? <Link href={c.href} className="truncate hover:text-gray-200">{c.label}</Link>
              : <span aria-current={i === items.length - 1 ? "page" : undefined} className="truncate text-gray-300">{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function CrumbMenu({ c }: { c: Crumb }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <span ref={box} className="relative min-w-0">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" className="flex max-w-full items-center gap-0.5 hover:text-gray-200">
        <span className="truncate">{c.label}</span><ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
      </button>
      {open && (
        <span role="menu" className="mobile-popover absolute left-0 z-40 mt-1.5 block w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-gray-800 p-1.5 shadow-2xl ring-1 ring-gray-600">
          {c.options!.map((o) => (
            <Link key={o.href} role="menuitem" href={o.href} onClick={() => setOpen(false)}
              className={cx("flex items-baseline gap-2 rounded-lg px-3 py-2 hover:bg-gray-700", o.current && "bg-gray-700/60")}>
              <span className="min-w-0 flex-1 truncate text-gray-200">{o.label}</span>
              {o.note && <span className="shrink-0 text-xs text-gray-400">{o.note}</span>}
            </Link>
          ))}
        </span>
      )}
    </span>
  );
}

const KEY = "plot:title";

/** Запомнить тайтл, сюжет которого сейчас смотрят (на время вкладки). */
export function useRememberTitle(id: number) {
  useEffect(() => { try { sessionStorage.setItem(KEY, String(id)); } catch { /* без хранилища — путь по первому появлению */ } }, [id]);
}

/** Тайтл, откуда пришли на страницу без тайтла в адресе; читается после монтирования (сервер его не знает). */
export function useRememberedTitle(): number | null {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => { try { setId(Number(sessionStorage.getItem(KEY)) || null); } catch { /* без хранилища — нет */ } }, []);
  return id;
}
