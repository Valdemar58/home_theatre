import { mangaAi, queueMangaTranslate } from "@/server/books/manga-translate";
import { ApiError, authed, json } from "@/server/route";
import { latestTask } from "@/server/tasks";

// Перевод страниц манги ИИ (TASKS 5.8): ?provider=&cref= — готовый слой пузырей и состояние задачи; POST — запустить.

export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  const q = new URL(req.url).searchParams;
  const provider = q.get("provider") ?? "", cref = q.get("cref") ?? "";
  const k = mangaAi(Number(id), provider, cref);
  const t = latestTask("manga_translate", `${id}|${provider}|${cref}`);
  return json({ pages: k?.value.pages ?? null, model: k?.prov.model ?? null, task: t ? { status: t.status, error: t.error ?? null } : null });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const b = (await req.json().catch(() => ({}))) as { provider?: string; cref?: string };
  if (!b.provider || !b.cref) throw new ApiError(400, "Нужны provider и cref");
  await queueMangaTranslate(user.id, Number(id), b.provider, b.cref);
  return json({ ok: true });
});
