import "server-only";
import type { Block, BookDetails, ChapterRow, Edition } from "@/lib/books";

// Провайдер глав (как источники в Tachimanga): находит книгу у себя, отдаёт оглавление (главы по языкам и командам)
// и саму главу — текст (ранобэ) или страницы (манга). Встроенные: Lib (ranobelib, mangalib), MangaDex, Syosetu;
// мосты к чужим расширениям (Suwayomi, плагины LNReader) подключаются тем же интерфейсом.

/** Книга у провайдера — кандидат на сопоставление. */
export type Hit = {
  provider: string;
  ref: string;
  title: string;
  titles: string[];
  year: number | null;
  cover: string | null;
  url: string;
  edition: Edition;
  /** Провайдер сам знает id AniList (MangaDex) — сопоставление без сомнений */
  anilistId?: number | null;
  /** Подсказка для выбора вручную: издание, статус, лицензия */
  note?: string | null;
};

export type Page = { url: string; w?: number | null; h?: number | null };

export type Content =
  | { kind: "text"; blocks: Block[] }
  | { kind: "pages"; pages: Page[] }
  /** Глава у официального издателя (MangaDex даёт только ссылку) */
  | { kind: "external"; url: string };

export interface Provider {
  id: string;
  name: string;
  /** Что умеет: манга (страницы) и/или ранобэ (текст) */
  kinds: ("manga" | "novel")[];
  /** Языки переводов («ja» — оригинал) */
  langs: string[];
  /** Найти книгу: по своему запросу или по названиям нашей книги */
  search(book: BookDetails, query?: string): Promise<Hit[]>;
  chapters(ref: string, edition: Edition): Promise<ChapterRow[]>;
  content(ref: string, cref: string): Promise<Content>;
  bookUrl(ref: string): string;
  /** Заголовки для картинок страниц и иллюстраций (Referer — без него картинку не отдают) */
  imageHeaders?: Record<string, string>;
}

/** Несколько названий книги для поиска у провайдера: латиница, английское, русское, родное (без повторов). */
export function searchQueries(book: BookDetails, query?: string, max = 3): string[] {
  if (query?.trim()) return [query.trim()];
  const seen = new Set<string>();
  return [book.title.romaji, book.title.english, book.title.ru, book.title.native]
    .filter((t): t is string => Boolean(t?.trim()))
    .filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)))
    .slice(0, max);
}
