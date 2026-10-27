"use client";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useEffect, useState } from "react";

// Путь страницы: «Тайтл › Персонажи › Римуру». Страницы сюжета тайтла запоминают тайтл на время вкладки, чтобы
// страница персонажа (адрес без тайтла: персонаж общий для франшизы) вела обратно в тот сезон, откуда пришли.

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Путь" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm text-gray-400">
        {items.map((c, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-gray-600" />}
            {c.href && i < items.length - 1
              ? <Link href={c.href} className="truncate hover:text-gray-200">{c.label}</Link>
              : <span aria-current={i === items.length - 1 ? "page" : undefined} className="truncate text-gray-300">{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
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
