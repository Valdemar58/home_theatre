import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import { db, now } from "./db";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { parseInfoboxImages } from "@/lib/fandom-images";
import { sameName } from "@/lib/plot-graph";
import { cached } from "./cache";
import { fetchWithRetry, RateLimiter } from "./http";
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
  const rows = db.prepare<[number], { entity_id: number; url: string; label: string | null; source: string }>(`
    SELECT i.entity_id, i.url, i.label, i.source FROM plot_image i WHERE i.checked IS NULL
    AND i.entity_id IN (SELECT entity_id FROM plot_appearance WHERE anilist_id = ? AND first_ep IS NOT NULL)`).all(anilistId);
  let done = 0;
  for (const r of rows) {
    signal?.throwIfAborted();
    const looks = db.prepare<[number], LookRow>(
      "SELECT look, label, label_en, appearance, kind, anilist_id, from_ep FROM plot_look WHERE entity_id = ? ORDER BY from_ep").all(r.entity_id);
    const set = db.prepare("UPDATE plot_image SET look = ?, label = ?, anilist_id = ?, from_ep = ?, checked = ?, updated_at = ? WHERE entity_id = ? AND url = ?");
    const current = looks.filter((l) => l.kind !== "прошлое");
    const many = db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM plot_image WHERE entity_id = ?").get(r.entity_id)!.n > 1;
    if (current.length <= 1 && !many) {
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
      // Оригинал в PNG: кэш и Fandom отдают webp, его модель может не прочитать
      image = (await sharp(await readFile((await originalFile(r.url)).file)).png().toBuffer()).toString("base64");
    } catch {
      continue;
    }
    const user = `${r.label ? `Подпись картинки на вики: ${r.label}\n` : ""}Облики:\n${looks.map((l) => `${l.look}: ${l.label_en ?? l.label} — ${l.appearance ?? l.label}${l.kind === "прошлое" ? " (прошлая жизнь)" : ""}`).join("\n")}`;
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

// ---------------------------------------------------------------- картинки обликов с Fandom

const fandom = new RateLimiter(700);
const UA = "home-theater/1.0 (personal media server)";

async function wikiJson<T>(url: string): Promise<T | null> {
  const res = await fetchWithRetry(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, fandom, { timeoutMs: 30_000 });
  return res.ok ? ((await res.json()) as T) : null;
}

type Parse = { parse?: { title: string; text: string }; error?: { code: string } };

/** Врезка персонажа на вики: страница по имени, иначе первая в поиске, если её название — то же имя. */
async function infobox(host: string, name: string) {
  const api = `https://${host}/api.php?format=json&formatversion=2&`;
  const page = (title: string) => wikiJson<Parse>(`${api}action=parse&redirects=1&prop=text&section=0&page=${encodeURIComponent(title)}`);
  let p = await page(name);
  if (!p?.parse) {
    const s = await wikiJson<{ query?: { search?: { title: string }[] } }>(`${api}action=query&list=search&srlimit=1&srsearch=${encodeURIComponent(name)}`);
    const t = s?.query?.search?.[0]?.title;
    if (t && (sameName(t, name) || t.toLowerCase().includes(name.split(" ")[0].toLowerCase()))) p = await page(t);
  }
  return p?.parse ? parseInfoboxImages(p.parse.text) : [];
}

/**
 * Картинки обликов с вики тайтла (та, с которой корпус брал пересказы серий) — кандидатами в plot_image.
 * Серию каждой картинке назначит checkLooks; не узнанная картинка с вики не показывается (там бывают формы из поздних сезонов).
 */
export async function fandomLooks(anilistId: number, signal?: AbortSignal): Promise<number> {
  const url = db.prepare<[number], { url: string }>("SELECT url FROM episode_text WHERE anilist_id = ? AND source = 'fandom' AND url IS NOT NULL LIMIT 1").get(anilistId)?.url;
  if (!url) return 0;
  const host = new URL(url).host;
  // Связанные с AniList — первыми: при двух персонажах с одним именем страница вики достаётся им
  const chars = db.prepare<[number], { id: number; name: string }>(`
    SELECT e.id, e.name FROM plot_entity e JOIN plot_appearance a ON a.entity_id = e.id
    WHERE a.anilist_id = ? AND a.first_ep IS NOT NULL AND e.kind = 'character' ORDER BY e.anilist_char_id IS NULL, a.first_ep`).all(anilistId);
  const put = db.prepare("INSERT INTO plot_image (entity_id, url, source, label, updated_at) VALUES (?, ?, 'fandom', ?, ?) ON CONFLICT (entity_id, url) DO NOTHING");
  let added = 0;
  // Одна картинка — одному персонажу тайтла: страница ищется по имени, и двое «Гельдов» получали одну и ту же
  const taken = new Map<string, number>();
  const drop = db.prepare("DELETE FROM plot_image WHERE entity_id = ? AND url = ? AND source = 'fandom'");
  for (const c of chars) {
    signal?.throwIfAborted();
    // Вики меняются редко — месяц из кэша
    const imgs = await cached(`fandom-img:v1:${host}:${c.name}`, 30 * 86400, () => infobox(host, c.name)).catch(() => []);
    for (const im of imgs) {
      const owner = taken.get(im.url);
      if (owner !== undefined && owner !== c.id) { drop.run(c.id, im.url); continue; }
      taken.set(im.url, c.id);
      added += Number(put.run(c.id, im.url, im.label || null, now()).changes);
    }
  }
  return added;
}
