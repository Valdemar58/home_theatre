import "server-only";
import { getCached } from "../cache";
import { db } from "../db";
import { booksForAnime, type AnimeBook } from "./anilist-books";

// «По аниме, которое смотрел» (TASKS 5.10): первоисточники и адаптации аниме из моего списка, которых нет в списке
// чтения. Книги аниме — из хранилища; чего там нет — догружается в фоне понемногу (следующий заход покажет больше).

const g = globalThis as unknown as { __animeBooksFill?: boolean };

export function booksFromMyAnime(userId: number, kind: "manga" | "novel"): (AnimeBook & { anime: number })[] {
  const anime = db.prepare<[number], { anilist_id: number }>(
    "SELECT anilist_id FROM list_entries WHERE user_id = ? AND deleted = 0 AND status IN ('completed', 'watching', 'rewatching') ORDER BY updated_at DESC LIMIT 300").all(userId);
  const reading = new Set(db.prepare<[number], { book_id: number }>("SELECT book_id FROM read_entries WHERE user_id = ? AND deleted = 0").all(userId).map((r) => r.book_id));
  const out = new Map<number, AnimeBook & { anime: number }>();
  const missing: number[] = [];
  for (const { anilist_id: id } of anime) {
    const books = getCached<AnimeBook[]>(`book-meta:anime:${id}`, true);
    if (!books) { missing.push(id); continue; }
    for (const b of books) {
      if (b.relationType !== "SOURCE" && b.relationType !== "ADAPTATION") continue;
      if ((b.format === "NOVEL") !== (kind === "novel") || reading.has(b.id) || out.has(b.id)) continue;
      out.set(b.id, { ...b, anime: id });
    }
  }
  if (missing.length && !g.__animeBooksFill) {
    g.__animeBooksFill = true;
    void (async () => {
      for (const id of missing.slice(0, 20)) await booksForAnime(id).catch(() => null);
    })().finally(() => { g.__animeBooksFill = false; });
  }
  return [...out.values()].slice(0, 24);
}
