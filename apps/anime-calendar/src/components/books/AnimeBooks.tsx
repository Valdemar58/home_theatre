"use client";
import Link from "next/link";
import { useBooksForAnime } from "@/lib/client";
import { Img } from "../Img";

// На странице аниме: первоисточник (манга, ранобэ) и связанные книги — ссылками в раздел «Читать».

const REL: Record<string, string> = { SOURCE: "Первоисточник", ADAPTATION: "Адаптация", SPIN_OFF: "Спин-офф", SIDE_STORY: "Побочная история", ALTERNATIVE: "Другая версия", OTHER: "Связано" };

export function AnimeBooks({ id }: { id: number }) {
  const { data } = useBooksForAnime(id);
  const books = data?.books ?? [];
  if (!books.length) return null;
  return (
    <section>
      <h2 className="mb-3 text-xl font-bold">Читать</h2>
      <div className="flex flex-wrap gap-3">
        {books.slice(0, 8).map((b) => (
          <Link key={b.id} href={`/manga/${b.id}`} className="flex w-full items-center gap-3 rounded-lg bg-gray-800/50 p-2 pr-4 ring-1 ring-gray-700 hover:bg-gray-800 sm:w-auto sm:max-w-xs">
            {b.cover ? <Img src={b.cover} size="thumb" className="h-14 w-10 shrink-0 rounded object-cover" /> : <div className="h-14 w-10 shrink-0 rounded bg-gray-800" />}
            <span className="min-w-0">
              <span className="block truncate text-sm text-gray-100">{b.ru ?? b.title}</span>
              <span className="block text-xs text-gray-400">{REL[b.relationType] ?? "Связано"} · {b.format === "NOVEL" ? "ранобэ" : "манга"}{b.year ? ` · ${b.year}` : ""}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
