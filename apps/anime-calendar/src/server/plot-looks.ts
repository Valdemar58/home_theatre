import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import { db, now } from "./db";
import { readFile } from "node:fs/promises";
import { originalFile } from "./img-cache";
import { LlmUnavailable, runTask } from "./llm";

// Картинки персонажа → облик и серия, с которой их можно показывать (задача look, только локальная модель со зрением).
// Портрет AniList часто рисует облик из поздних серий (Римуру-человек, а в начале он слизь): без проверки картинка
// показывается с последнего облика первого тайтла (plot-graph imagesOf), после проверки — с серии своего облика.

type LookRow = { look: string; label: string; label_en: string | null; appearance: string | null; kind: string; anilist_id: number; from_ep: number };

const SYSTEM = `Тебе показывают картинку персонажа аниме и список его обликов из сериала. Выбери облик, который на картинке.
Смотри на внешность: тело, волосы, одежду, маску. Если на картинке нет ни одного облика из списка или не уверен — «none».`;

/** Проверить картинки персонажей тайтла, у которых несколько обликов. Возвращает число проверенных. */
export async function checkLooks(anilistId: number, signal?: AbortSignal): Promise<number> {
  const rows = db.prepare<[number], { entity_id: number; url: string }>(`
    SELECT i.entity_id, i.url FROM plot_image i WHERE i.checked IS NULL
    AND i.entity_id IN (SELECT entity_id FROM plot_appearance WHERE anilist_id = ? AND first_ep IS NOT NULL)`).all(anilistId);
  let done = 0;
  for (const r of rows) {
    signal?.throwIfAborted();
    const looks = db.prepare<[number], LookRow>(
      "SELECT look, label, label_en, appearance, kind, anilist_id, from_ep FROM plot_look WHERE entity_id = ? ORDER BY from_ep").all(r.entity_id);
    const set = db.prepare("UPDATE plot_image SET look = ?, label = ?, anilist_id = ?, from_ep = ?, checked = ?, updated_at = ? WHERE entity_id = ? AND url = ?");
    const current = looks.filter((l) => l.kind !== "прошлое");
    if (current.length <= 1) {
      // Облик один — картинка известна с первого появления
      const first = db.prepare<[number], { anilist_id: number; first_ep: number }>(
        "SELECT anilist_id, first_ep FROM plot_appearance WHERE entity_id = ? AND first_ep IS NOT NULL ORDER BY first_ep LIMIT 1").get(r.entity_id);
      if (first) set.run(current[0]?.look ?? null, current[0]?.label ?? null, first.anilist_id, first.first_ep, "single", now(), r.entity_id, r.url);
      done++;
      continue;
    }
    const keys = looks.map((l) => l.look);
    const schema: JsonSchema = { type: "object", properties: { look: { type: "string", enum: [...keys, "none"] } }, required: ["look"] };
    let image: string;
    try {
      // Оригинал (jpg/png AniList): уменьшенные копии кэша — webp, его модель может не прочитать
      image = (await readFile((await originalFile(r.url)).file)).toString("base64");
    } catch {
      continue;
    }
    const user = `Облики:\n${looks.map((l) => `${l.look}: ${l.label_en ?? l.label} — ${l.appearance ?? l.label}${l.kind === "прошлое" ? " (прошлая жизнь)" : ""}`).join("\n")}`;
    try {
      const res = await runTask<{ look: string }>("look", { schema, system: SYSTEM, user, images: [image], maxTokens: 200, timeoutMs: 120_000 });
      const hit = looks.find((l) => l.look === res.value.look);
      // Не узнала — оставляем без серии: покажется осторожно, с последнего облика
      set.run(hit?.look ?? null, hit?.label ?? null, hit?.anilist_id ?? null, hit?.from_ep ?? null, res.model, now(), r.entity_id, r.url);
      done++;
    } catch (e) {
      if (e instanceof LlmUnavailable) return done;
      throw e;
    }
  }
  return done;
}
