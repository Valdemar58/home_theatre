import { authed, intParam, json } from "@/server/route";
import { translateEpisode } from "@/server/translate";

/** Перевести текст серии из корпуса на русский (ждёт ИИ: локально — до пары минут на длинный пересказ). */
export const POST = authed<{ id: string }>(async (req, _user, { id }) => {
  const body = (await req.json().catch(() => ({}))) as { ep?: number; source?: string };
  const tr = await translateEpisode(intParam(id, "id"), intParam(String(body.ep), "ep"), String(body.source ?? ""));
  return json({ text: tr.text, model: tr.model, provider: tr.provider });
});
