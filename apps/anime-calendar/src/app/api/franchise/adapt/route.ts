import { setAdapt } from "@/server/adapt";
import { ApiError, authed, json } from "@/server/route";

/** Что из книги адаптирует сезон — ручная правка: { anime, form, unit, from, to } или { anime, clear: true }. */
export const PUT = authed(async (req, user) => {
  const b = (await req.json()) as { anime?: number; form?: string; unit?: string; from?: number; to?: number; clear?: boolean };
  const anime = Number(b.anime);
  if (!Number.isInteger(anime) || anime <= 0) throw new ApiError(400, "Нет тайтла");
  if (b.clear) return json({ ok: setAdapt(user.id, anime, null) ?? true });
  const from = Number(b.from), to = Number(b.to);
  if ((b.form !== "novel" && b.form !== "manga") || (b.unit !== "vol" && b.unit !== "ch") || !(from > 0) || !(to > 0) || to > 5000)
    throw new ApiError(400, "Укажите форму, единицу и номера");
  setAdapt(user.id, anime, { form: b.form, unit: b.unit, from, to });
  return json({ ok: true });
});
