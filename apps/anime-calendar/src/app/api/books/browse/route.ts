import { browseBooks, type BookBrowse } from "@/server/books/anilist-books";
import { booksFromMyAnime, knownRu } from "@/server/books/discover";
import { authed, json } from "@/server/route";

const pick = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);

/** Каталог книг: ?kind=manga|novel&sub=&sort=&status=&genres=a,b&page= ; на первой странице — книги по моим аниме. */
export const GET = authed(async (req, user) => {
  const u = new URL(req.url).searchParams;
  const f: BookBrowse = {
    kind: pick(u.get("kind"), ["manga", "novel"] as const) ?? "manga",
    sub: pick(u.get("sub"), ["manga", "manhwa", "manhua", "oneshot"] as const),
    sort: pick(u.get("sort"), ["popular", "score", "trending", "new"] as const) ?? "popular",
    status: pick(u.get("status"), ["RELEASING", "FINISHED"] as const),
    genres: (u.get("genres") ?? "").split(",").filter(Boolean).slice(0, 5),
    page: Math.max(1, Math.min(50, Number(u.get("page")) || 1)),
  };
  const res = await browseBooks(f);
  const fromAnime = f.page === 1 ? booksFromMyAnime(user.id, f.kind) : null;
  return json({ ...res, fromAnime, ru: knownRu([...res.books.map((b) => b.id), ...(fromAnime ?? []).map((b) => b.id)]) });
});
