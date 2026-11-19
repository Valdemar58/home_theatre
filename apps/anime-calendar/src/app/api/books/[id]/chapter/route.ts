import { parseAiCref } from "@/lib/book-translate";
import type { Edition } from "@/lib/books";
import { aiChapter } from "@/server/books/ai-chapters";
import { chapterContent } from "@/server/books/library";
import { pageUrl } from "@/server/books/pages-cache";
import { ApiError, authed, json } from "@/server/route";

/** Глава для ридера: ?provider=&cref= → текст (абзацы, иллюстрации) или страницы; картинки — через календарь. */
export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  const u = new URL(req.url);
  const provider = u.searchParams.get("provider") ?? "";
  const cref = u.searchParams.get("cref") ?? "";
  if (!provider || !cref) throw new ApiError(400, "Нужны provider и cref");
  const c = await chapterContent(Number(id), provider, cref, u.searchParams.get("refresh") === "1").catch((e: unknown) => {
    throw new ApiError(e instanceof Error && /нет у книги/.test(e.message) ? 404 : 502, e instanceof Error ? e.message : String(e));
  });
  if (c.kind === "pages") return json({ ...c, pages: c.pages.map((p) => ({ ...p, url: pageUrl(provider, p.url) })) });
  // Иллюстрации перевода ИИ — от провайдера оригинала (его Referer)
  const ai = provider === "ai" ? parseAiCref(cref) : null;
  const imgFrom = ai ? aiChapter(Number(id), ai.edition as Edition, ai.key)?.value.source.provider ?? provider : provider;
  if (c.kind === "text") return json({ ...c, blocks: c.blocks.map((b) => (b.t === "img" ? { ...b, url: pageUrl(imgFrom, b.url) } : b)) });
  return json(c);
});
