import { corpusOf } from "@/server/corpus-store";
import { corpusState } from "@/server/plot-corpus";
import { adminOnly, authed, intParam, json } from "@/server/route";
import { startTask } from "@/server/tasks";
import { storedTranslation } from "@/server/translate";
import type { EpisodeTexts } from "@/lib/types";

const DEPTH = { script: 0, full: 1, teaser: 2 } as const;

/** Корпус сюжета: идёт ли сбор, прогресс, сколько серий с текстом. С ?ep=N — тексты серии по источникам. */
export const GET = authed<{ id: string }>(async (req, _user, { id }) => {
  const n = intParam(id, "id");
  const ep = new URL(req.url).searchParams.get("ep");
  if (ep === null) return json(corpusState(n));
  const e = intParam(ep, "ep");
  const texts: EpisodeTexts = corpusOf(n, e).filter((t) => t.ep === e)
    .sort((a, b) => DEPTH[a.depth] - DEPTH[b.depth] || b.text.length - a.text.length)
    .map(({ source, lang, depth, title, text, url }) => {
      const tr = lang === "ru" ? null : storedTranslation(n, e, source, text);
      return { source, lang, depth, title, text, url, translation: tr && { text: tr.text, model: tr.model, provider: tr.provider } };
    });
  return json(texts);
});

/** Собрать сюжет по кнопке (только админ: следом пойдёт платный пересказ). ?silent=1 — без уведомления (замеры). */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const silent = new URL(req.url).searchParams.has("silent");
  await startTask("corpus", String(n), { userId: user.id, origin: "user", notify: !silent });
  return json(corpusState(n));
});
