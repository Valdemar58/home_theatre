import type { Edition } from "@/lib/books";
import { aiChapter } from "@/server/books/ai-chapters";
import { queueTranslate } from "@/server/books/book-translate";
import { setBookPref } from "@/server/books/reading";
import { ApiError, authed, json } from "@/server/route";
import { latestTask } from "@/server/tasks";

// Перевод главы ИИ (TASKS 5.7): состояние (?edition=&key=) и запуск { edition, key, ahead? } — ahead > 0 переводит
// и следующие главы, а у книги запоминается «переводить вперёд на ahead глав» (0 — выключить).

const taskKey = (id: string, edition: string, key: string) => `${id}|${edition}|${key}`;

export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  const q = new URL(req.url).searchParams;
  const edition = (q.get("edition") ?? "main") as Edition;
  const key = q.get("key") ?? "";
  const t = latestTask("book_translate", taskKey(id, edition, key));
  return json({ done: Boolean(aiChapter(Number(id), edition, key)), task: t ? { status: t.status, error: t.error ?? null } : null });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const b = (await req.json().catch(() => ({}))) as { edition?: Edition; key?: string; ahead?: number };
  if (!b.edition || !b.key) throw new ApiError(400, "Нужны edition и key");
  const ahead = Math.max(0, Math.min(20, Math.floor(Number(b.ahead) || 0)));
  if (b.ahead !== undefined) setBookPref(user.id, Number(id), { aiAhead: ahead });
  await queueTranslate(user.id, Number(id), b.edition, b.key, ahead);
  return json({ ok: true });
});
