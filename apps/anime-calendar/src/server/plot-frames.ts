import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { JsonSchema } from "@/lib/json-lite";
import { parseSubs } from "@/lib/sdh";
import { consistent, isCrowdLabel, matchByName } from "@/lib/speakers";
import type { CorpusProgress } from "@/lib/types";
import { getDetails } from "./anilist";
import { db, now } from "./db";
import { originalFile } from "./img-cache";
import { bestOutput, hashOf, recordOutput } from "./knowledge";
import { env } from "./env";
import { mappingForAnilist } from "./idmap";
import { LlmUnavailable, runTask } from "./llm";
import { titleCharacters } from "./plot-graph";
import { jellyfin, jellyfinSeries } from "./stream";
import { registerHandler } from "./tasks";

// Кадры из своих серий — картинки обликов, которых нет ни на AniList, ни на Fandom (Сатору до перерождения,
// «человек с ножом», слизь). Облик ищем в серии, где его впервые показали: моменты реплик персонажа по субтитрам
// (иначе — равномерно по серии) → кадр через ffmpeg → модель со зрением находит персонажа и оценивает кадр →
// вырезаем портрет 2:3, лучший сохраняем. Кадр показывается с серии, из которой взят: сам по себе не спойлер.
// Видео — файл из библиотеки Jellyfin (поток Jellyfin) или серия «Стрима» (ссылка TorrServer из .strm). Только локально.

const DIR = () => path.join(process.env.DATA_DIR ?? "./data", "plot");
const PER_LOOK = 10;
const KEEP_SCORE = 6;

// ---------------------------------------------------------------- видео серии

type Source = { url: string; headers: string };

/** Видео серии AniList: эпизод сериала Jellyfin по TVDB (сезон и сдвиг — из сопоставления). */
export async function episodeSource(anilistId: number, ep: number): Promise<Source | null> {
  const m = await mappingForAnilist(anilistId);
  if (!m || m.season === "a") return null;
  const number = ep + m.offset;
  const series = (await jellyfinSeries()).filter((s) => s.ProviderIds?.Tvdb === String(m.tvdb) || s.Path?.includes(`[tvdbid-${m.tvdb}]`));
  for (const s of series) {
    const r = await jellyfin<{ Items: { Id: string; IndexNumber?: number; Path?: string }[] }>(`/Shows/${s.Id}/Episodes?season=${m.season}&Fields=Path`).catch(() => null);
    const e = r?.Items.find((x) => x.IndexNumber === number);
    if (!e) continue;
    // Серия «Стрима»: в .strm — ссылка на TorrServer, файл виден и нам (та же папка)
    if (e.Path?.endsWith(".strm")) {
      const local = e.Path.replace(env.jellyfinStreamPath, env.streamDir);
      const url = fs.existsSync(local) ? fs.readFileSync(local, "utf-8").trim() : "";
      if (url) return { url, headers: "" };
      continue;
    }
    return { url: `${env.jellyfinUrl}/Videos/${e.Id}/stream?static=true`, headers: `Authorization: MediaBrowser Token="${env.jellyfinApiKey}"\r\n` };
  }
  return null;
}

/**
 * Кадр около секунды t (полный размер, JPEG): опорный кадр перед t (-noaccurate_seek). Из раздачи читается только он —
 * без декодирования секунд видео до точной метки; у BD опорный кадр к тому же самый чёткий.
 */
function grab(src: Source, t: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", ...(src.headers ? ["-headers", src.headers] : []), "-noaccurate_seek", "-ss", String(t), "-i", src.url, "-frames:v", "1", "-q:v", "3", "-f", "image2", "pipe:1"];
    const p = spawn("ffmpeg", args);
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length) resolve(out);
      else reject(new Error(`ffmpeg: ${err.trim().slice(0, 200) || `код ${code}`}`));
    });
  });
}

// ---------------------------------------------------------------- когда персонаж в кадре

/**
 * Моменты реплик в серии (мс → с) по меткам говорящих. labels — точные метки облика (из speakerMap: «三上» — Сатору,
 * «スライム» — слизь), иначе — японские имена персонажа (из графа и AniList), с совпадением по вхождению.
 */
async function speechTimes(anilistId: number, ep: number, labels: string[], names: string[]): Promise<number[]> {
  const f = db.prepare<[number, number], { name: string; path: string }>("SELECT name, path FROM sdh_file WHERE anilist_id = ? AND ep = ?").get(anilistId, ep);
  if (!f || (!labels.length && !names.length) || !fs.existsSync(f.path)) return [];
  const subs = parseSubs(f.name, await readFile(f.path, "utf-8"));
  const hit = labels.length ? (label: string) => labels.includes(label) : (label: string) => names.some((n) => n.includes(label) || label.includes(n));
  return subs.cues.filter((c) => c.lines.some((l) => l.kind === "speech" && l.speakers.some(hit))).map((c) => (c.start + c.end) / 2000);
}

// Метки говорящих называют облик, а не персонажа: «三上» — Сатору до перерождения, «スライム» — Римуру-слизь,
// «通り魔» — человек с ножом. Сопоставление — сначала без модели: толпа отсекается правилами, метка, совпавшая с японским
// именем, — строкой. Модели остаются спорные метки: с репликами и сериями, выбор — из готовых вариантов по именам.
// Любое сопоставление проверяется фактами: метка не звучит раньше первого появления персонажа. Результат модели —
// в журнале знаний (пересчёт — если поменялись спорные метки или персонажи)
const SPEAKERS_V = 3;
const NOBODY = "никто из списка";

type LabelInfo = { label: string; count: number; firstEp: number; samples: string[] };
type Person = { id: number; name: string; firstEp: number; names: string[] };
type LookOpt = { entity: number; look: string; label: string; kind: string };

/** Метки тайтла: сколько реплик, с какой серии, пара реплик для контекста. */
async function titleLabels(anilistId: number): Promise<LabelInfo[]> {
  const by = new Map<string, LabelInfo>();
  for (const f of db.prepare<[number], { name: string; path: string; ep: number }>("SELECT name, path, ep FROM sdh_file WHERE anilist_id = ? ORDER BY ep").all(anilistId)) {
    if (!fs.existsSync(f.path)) continue;
    for (const c of parseSubs(f.name, await readFile(f.path, "utf-8")).cues) for (const l of c.lines) {
      if (l.kind !== "speech") continue;
      for (const s of l.speakers) {
        const x = by.get(s) ?? { label: s, count: 0, firstEp: f.ep, samples: [] };
        x.count++;
        if (x.samples.length < 3 && l.text.trim().length > 4) x.samples.push(`с. ${f.ep}: ${l.text.trim().slice(0, 60)}`);
        by.set(s, x);
      }
    }
  }
  return [...by.values()].filter((x) => x.count >= 2 && !isCrowdLabel(x.label)).sort((a, b) => b.count - a.count).slice(0, 150);
}

/** Метки говорящих тайтла → (персонаж, облик). Облик пуст, если метка — просто имя персонажа. */
async function speakerMap(anilistId: number): Promise<Map<string, { entity: number; look: string | null }>> {
  const labels = await titleLabels(anilistId);
  if (!labels.length) return new Map();
  const d = await getDetails(anilistId);
  const native = new Map((await titleCharacters(anilistId, d.idMal).catch(() => [])).map((c) => [c.id, c.native]));
  const people: Person[] = db.prepare<[number], { id: number; name: string; name_ja: string | null; anilist_char_id: number | null; first_ep: number }>(`
    SELECT e.id, COALESCE(e.name_ru, e.name) AS name, e.name_ja, e.anilist_char_id, a.first_ep FROM plot_entity e JOIN plot_appearance a ON a.entity_id = e.id
    WHERE a.anilist_id = ? AND a.first_ep IS NOT NULL AND e.kind = 'character'`).all(anilistId)
    .map((p) => ({ id: p.id, name: p.name, firstEp: p.first_ep, names: [p.name_ja, p.anilist_char_id ? native.get(p.anilist_char_id) : null].filter((x): x is string => Boolean(x)) }));
  const byId = new Map(people.map((p) => [p.id, p]));
  const looks: LookOpt[] = db.prepare<[number], { entity_id: number; look: string; label: string; kind: string }>("SELECT entity_id, look, label, kind FROM plot_look WHERE anilist_id = ?").all(anilistId)
    .map((l) => ({ entity: l.entity_id, look: l.look, label: l.label, kind: l.kind }));
  const out = new Map<string, { entity: number; look: string | null }>();
  const open: LabelInfo[] = [];
  for (const l of labels) {
    // Строкой: одно совпадение, и метка не звучит раньше появления персонажа
    const hit = matchByName(l.label, people).filter((id) => consistent(l.firstEp, byId.get(id)!));
    if (hit.length === 1) out.set(l.label, { entity: hit[0], look: null });
    else open.push(l);
  }
  if (!open.length) return out;
  // Варианты — по именам (не номерам: в длинном списке номеров модель промахивалась), облики — отдельными вариантами
  const options = new Map<string, { entity: number; look: string | null }>();
  for (const p of people) options.set(p.name, { entity: p.id, look: null });
  for (const lo of looks) {
    const p = byId.get(lo.entity);
    if (p && lo.kind !== "обычный") options.set(`${p.name} — облик «${lo.label}»`, { entity: lo.entity, look: lo.look });
  }
  const names = [...options.keys(), NOBODY];
  const schema: JsonSchema = {
    type: "object",
    properties: { map: { type: "array", items: { type: "object", properties: { label: { type: "string" }, who: { type: "string", enum: names } }, required: ["label", "who"] } } },
    required: ["map"],
  };
  const user = [
    `Варианты (выбирай строку целиком):\n${names.join("\n")}`,
    `Метки:\n${open.map((l) => `${l.label} — ${l.count} реплик, с ${l.firstEp} серии; ${l.samples.join(" / ")}`).join("\n")}`,
  ].join("\n\n");
  const inputHash = hashOf([SPEAKERS_V, user]);
  const subject = `speakers:${anilistId}`;
  type Answer = { map: { label: string; who: string }[] };
  let value = bestOutput<Answer>("look", subject, { inputHash, policy: "tier-first", staleOk: false })?.value;
  if (!value) {
    // Текстовая задача — дешёвой внешней модели (пул разбора графа)
    const res = await runTask<Answer>("plot_graph", {
      schema, maxTokens: 8000, timeoutMs: 300_000,
      system: `Метки говорящих из японских субтитров аниме: кто это из вариантов. У каждой метки — реплики с номерами серий.
- Метка называет говорящего: имя, фамилию, прозвище, роль. «三上» — фамилия Сатору Миками до перерождения, «スライム» — герой в облике слизи.
- Если метка называет особый облик персонажа (прошлая жизнь, форма, маскировка) и такой вариант есть — выбери его.
- Не уверен или это не персонаж из списка — «${NOBODY}».`,
      user,
    });
    value = res.value;
    recordOutput("look", subject, res, value, { schemaV: 2, promptV: SPEAKERS_V, inputHash });
  }
  for (const m of value.map) {
    const o = options.get(m.who);
    const l = open.find((x) => x.label === m.label);
    // Проверка фактами: метка не может звучать раньше появления персонажа
    if (o && l && consistent(l.firstEp, byId.get(o.entity)!)) out.set(l.label, o);
  }
  return out;
}

/** До n моментов: реплики — вразброс по серии; без них — равномерно, мимо опенинга и эндинга. */
function pickTimes(speech: number[], minutes: number, n: number): number[] {
  if (speech.length) {
    const step = Math.max(1, Math.floor(speech.length / n));
    return speech.filter((_, i) => i % step === 0).slice(0, n);
  }
  const from = 150, to = Math.max(from + 60, minutes * 60 - 150);
  return Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * (i + 0.5)) / n));
}

// ---------------------------------------------------------------- модель со зрением

// Рамку модель ставит точно только в своём формате (bbox_2d, доли 0–1000) и без ограничения схемой: со схемой
// она отвечала рамкой во весь кадр. Ответ всё равно проверяется по схеме; рамки нет — персонажа в кадре нет
const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    bbox_2d: { type: "array", items: { type: "integer", minimum: 0, maximum: 1000 } },
    score: { type: "integer", minimum: 0, maximum: 10 },
  },
};

const SYSTEM = `You look at a frame from an anime and a character description.`;
const ask = (who: string) => `Locate the face of ${who} in the image.
Output one JSON object: {"bbox_2d": [x1, y1, x2, y2], "score": N} where score 0-10 rates the frame as a portrait of this character (face clearly visible, large, sharp, not cut off).
If this character is not in the image or the face is not visible, output {"bbox_2d": null, "score": 0}.`;

type Look = { entity: number; name: string; look: string | null; label: string; appearance: string; ep: number; namesJa: string[] };

/**
 * Кадр 16:9 в квадрат с полями (768 px — меньше токенов картинки): доли 0–1000 у модели совпадают с координатами
 * квадрата при любой её привычке (пиксели или доли).
 */
const SQ = 768;
async function square(frame: Buffer): Promise<{ img: Buffer; w: number; h: number }> {
  const meta = await sharp(frame).metadata();
  const w = meta.width ?? 1920, h = meta.height ?? 1080;
  const s = SQ / Math.max(w, h);
  const rw = Math.round(w * s), rh = Math.round(h * s);
  const img = await sharp(frame).resize(rw, rh).extend({ top: Math.floor((SQ - rh) / 2), bottom: Math.ceil((SQ - rh) / 2), left: Math.floor((SQ - rw) / 2), right: Math.ceil((SQ - rw) / 2), background: "#000" }).png().toBuffer();
  return { img, w, h };
}

/** Рамка лица (в квадрате, доли 0–1000) → портрет 2:3 в исходном кадре: лицо в верхней трети, с плечами. */
async function crop(frame: Buffer, w: number, h: number, box: number[]): Promise<Buffer | null> {
  const s = 1000 / Math.max(w, h);
  const ox = (1000 - w * s) / 2, oy = (1000 - h * s) / 2;
  const [x1, y1, x2, y2] = box.map((v, i) => (v - (i % 2 ? oy : ox)) / s);
  if (!(x2 > x1 && y2 > y1)) return null;
  const face = Math.max(y2 - y1, x2 - x1);
  const ph = Math.min(h, face * 3);
  const pw = Math.min(w, (ph * 2) / 3);
  const cx = (x1 + x2) / 2, top = Math.max(0, Math.min(h - ph, y1 - face * 0.5));
  const left = Math.max(0, Math.min(w - pw, cx - pw / 2));
  if (pw < 120 || ph < 180) return null;
  return sharp(frame).extract({ left: Math.round(left), top: Math.round(top), width: Math.round(pw), height: Math.round(ph) }).resize(400, 600, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
}

// ---------------------------------------------------------------- сверка с эталоном

/** Эталон персонажа — его картинка с AniList или Fandom (любой облик), PNG 512 px; нет — null. */
async function reference(entity: number): Promise<string | null> {
  const r = db.prepare<[number], { url: string }>(
    "SELECT url FROM plot_image WHERE entity_id = ? AND source IN ('anilist', 'fandom') ORDER BY source = 'anilist' DESC, from_ep IS NULL LIMIT 1").get(entity);
  if (!r) return null;
  try {
    const file = (await originalFile(r.url)).file;
    return (await sharp(await readFile(file)).resize(512, 512, { fit: "inside" }).png().toBuffer()).toString("base64");
  } catch {
    return null;
  }
}

const SAME_SCHEMA: JsonSchema = {
  type: "object",
  properties: { same: { type: "boolean" }, confidence: { type: "integer", minimum: 0, maximum: 10 } },
  required: ["same", "confidence"],
};

/**
 * Тот же ли персонаж на вырезанном кадре, что на эталоне. По одному описанию модель путает: на «огра-воина» подходит
 * и зелёный гоблин. Эталон может быть в другом облике (поздняя форма) — это говорим явно.
 */
async function sameCharacter(ref: string, crop: Buffer, l: Look): Promise<boolean> {
  const res = await runTask<{ same: boolean; confidence: number }>("look", {
    schema: SAME_SCHEMA, maxTokens: 200, timeoutMs: 120_000,
    images: [ref, (await sharp(crop).png().toBuffer()).toString("base64")],
    system: "You compare two anime images.",
    user: `Image 1 is a reference picture of ${l.name}. Image 2 is a crop from an episode.
Is image 2 the same character as image 1? In image 2 the character may look different: another form or an earlier stage (${l.label}: ${l.appearance}). Judge by face, hair, eyes, horns, distinctive features — not by clothes alone.
Answer JSON {"same": true|false, "confidence": 0-10}.`,
  });
  return res.value.same && res.value.confidence >= 7;
}

// ---------------------------------------------------------------- что искать

/** Облики персонажей тайтла без картинки (и персонажи без обликов и картинок вовсе) — с серией, где облик показан. */
function missingLooks(anilistId: number): Look[] {
  type Row = { entity_id: number; name: string; name_ja: string | null; look: string; label: string; appearance: string | null; from_ep: number };
  const rows = db.prepare<[number], Row>(`
    SELECT l.entity_id, COALESCE(e.name_ru, e.name) AS name, e.name_ja, l.look, l.label, l.appearance, l.from_ep
    FROM plot_look l JOIN plot_entity e ON e.id = l.entity_id
    WHERE l.anilist_id = ? AND e.kind = 'character'
      AND NOT EXISTS (SELECT 1 FROM plot_image i WHERE i.entity_id = l.entity_id AND i.look = l.look AND i.from_ep IS NOT NULL)`).all(anilistId);
  const bare = db.prepare<[number], { entity_id: number; name: string; name_ja: string | null; first_ep: number; description: string | null }>(`
    SELECT a.entity_id, COALESCE(e.name_ru, e.name) AS name, e.name_ja, a.first_ep,
      (SELECT description FROM plot_note n WHERE n.entity_id = a.entity_id AND n.anilist_id = a.anilist_id ORDER BY up_to LIMIT 1) AS description
    FROM plot_appearance a JOIN plot_entity e ON e.id = a.entity_id
    WHERE a.anilist_id = ? AND a.first_ep IS NOT NULL AND e.kind = 'character'
      AND NOT EXISTS (SELECT 1 FROM plot_look l WHERE l.entity_id = a.entity_id)
      AND NOT EXISTS (SELECT 1 FROM plot_image i WHERE i.entity_id = a.entity_id)`).all(anilistId);
  const ja = (id: number, own: string | null) => [own, db.prepare<[number], { name_ja: string | null }>("SELECT name_ja FROM plot_entity WHERE id = ?").get(id)?.name_ja]
    .filter((x): x is string => Boolean(x)).flatMap((n) => [n, ...n.split(/[・＝=\s]/)]).filter((n) => n.length >= 2);
  return [
    ...rows.map((r) => ({ entity: r.entity_id, name: r.name, look: r.look, label: r.label, appearance: r.appearance ?? r.label, ep: r.from_ep, namesJa: ja(r.entity_id, r.name_ja) })),
    ...bare.map((r) => ({ entity: r.entity_id, name: r.name, look: null, label: "обычный", appearance: r.description ?? r.name, ep: r.first_ep, namesJa: ja(r.entity_id, r.name_ja) })),
  ];
}

// ---------------------------------------------------------------- проход

const g_ = globalThis as unknown as { __framesProgress?: Map<number, CorpusProgress> };
const progress = (g_.__framesProgress ??= new Map());
export const framesProgress = (id: number) => progress.get(id) ?? null;

export async function findFrames(anilistId: number, signal: AbortSignal): Promise<{ found: number; looks: number; noVideo: number[] }> {
  const d = await getDetails(anilistId);
  // Кадры пересчитываются целиком: прежние (в том числе ошибочные) не должны остаться
  db.prepare(`DELETE FROM plot_image WHERE source = 'frame' AND entity_id IN (SELECT entity_id FROM plot_appearance WHERE anilist_id = ?)`).run(anilistId);
  const looks = missingLooks(anilistId);
  const p: CorpusProgress = { anilistId, step: "Кадры из серий", done: 0, total: looks.length, startedAt: Date.now(), updatedAt: Date.now(), finished: false, found: {}, errors: [], etaSec: null };
  progress.set(anilistId, p);
  const sources = new Map<number, Source | null>();
  // Эталоны главных героев — для проверки «на кадре не кто-то из известных» у персонажей без своей картинки
  const known: { entity: number; name: string; ref: string; from: number }[] = [];
  for (const m of db.prepare<[number], { entity_id: number; name: string; first_ep: number }>(`
    SELECT a.entity_id, COALESCE(e.name_ru, e.name) AS name, a.first_ep FROM plot_appearance a JOIN plot_entity e ON e.id = a.entity_id
    WHERE a.anilist_id = ? AND a.first_ep IS NOT NULL AND e.kind = 'character' AND a.role IN ('MAIN', 'SUPPORTING')
      AND EXISTS (SELECT 1 FROM plot_image i WHERE i.entity_id = a.entity_id AND i.source IN ('anilist', 'fandom'))
    ORDER BY a.role = 'MAIN' DESC, (SELECT COUNT(*) FROM plot_event_participant p WHERE p.entity_id = a.entity_id) DESC LIMIT 6`).all(anilistId)) {
    const ref = await reference(m.entity_id);
    if (ref) known.push({ entity: m.entity_id, name: m.name, ref, from: m.first_ep });
  }
  const speakers = await speakerMap(anilistId).catch((e) => {
    p.errors.push(`Метки говорящих: ${e instanceof Error ? e.message : String(e)}`);
    return new Map<string, { entity: number; look: string | null }>();
  });
  const dir = path.join(DIR(), String(anilistId), "frames");
  await mkdir(dir, { recursive: true });
  let found = 0;
  const noVideo = new Set<number>();
  const started = Date.now();
  for (const [i, l] of looks.entries()) {
    signal.throwIfAborted();
    // Прогресс — до пропусков (облик без видео или без опоры тоже «пройден»)
    Object.assign(p, { done: i, updatedAt: Date.now() });
    if (!sources.has(l.ep)) sources.set(l.ep, await episodeSource(anilistId, l.ep).catch(() => null));
    const src = sources.get(l.ep)!;
    if (!src) { noVideo.add(l.ep); continue; }
    // Метки облика: точные для этого облика, иначе — общие метки персонажа (облик пуст), иначе — японские имена
    const mine = [...speakers].filter(([, v]) => v.entity === l.entity);
    const exact = mine.filter(([, v]) => l.look !== null && v.look === l.look).map(([k]) => k);
    const labels = exact.length ? exact : mine.filter(([, v]) => !v.look).map(([k]) => k);
    const times = pickTimes(await speechTimes(anilistId, l.ep, labels, l.namesJa).catch(() => []), d.duration || 24, PER_LOOK);
    let best: { img: Buffer; score: number; t: number } | null = null;
    const ref = await reference(l.entity);
    // Ни эталона, ни реплик в субтитрах — угадывать по описанию в случайных кадрах бессмысленно
    if (!ref && !labels.length) continue;
    for (const t of times) {
      signal.throwIfAborted();
      try {
        const frame = await grab(src, t);
        const sq = await square(frame);
        const res = await runTask<{ bbox_2d?: number[]; score?: number }>("look", {
          schema: SCHEMA, system: SYSTEM, images: [sq.img.toString("base64")], maxTokens: 300, timeoutMs: 120_000, freeform: true,
          user: ask(`${l.appearance} (${l.name})`),
        });
        const v = { box: res.value.bbox_2d ?? [], score: res.value.score ?? 0 };
        // Без эталона опираемся только на описание — порог строже
        if (v.box.length !== 4 || v.score < (ref ? KEEP_SCORE : KEEP_SCORE + 2)) continue;
        const img = await crop(frame, sq.w, sq.h, v.box);
        if (!img) continue;
        if (ref && !(await sameCharacter(ref, img, l))) continue;
        // Без эталона: на кадре не должен узнаваться никто из известных героев (иначе это Римуру вместо «официантки»)
        if (!ref) {
          let other = false;
          for (const o of known.filter((k) => k.entity !== l.entity && k.from <= l.ep)) if ((other = await sameCharacter(o.ref, img, { ...l, name: o.name, label: "", appearance: "" }))) break;
          if (other) continue;
        }
        // Резкость портрета — при равной оценке модели лучше чёткий кадр
        const sharpness = (await sharp(img).stats()).sharpness;
        const score = v.score + Math.min(2, sharpness / 4);
        if (!best || score > best.score) best = { img, score, t };
        if (v.score >= 9) break;
      } catch (e) {
        if (e instanceof LlmUnavailable) throw e;
        if (signal.aborted) throw e;
        p.errors.push(`${l.name}, с. ${l.ep}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      }
    }
    if (best) {
      const file = `${l.entity}-${l.look ?? "base"}.jpg`;
      await writeFile(path.join(dir, file), best.img);
      const url = `/api/anime/${anilistId}/frames/${file}?t=${Math.round(best.t)}`;
      db.prepare("DELETE FROM plot_image WHERE entity_id = ? AND source = 'frame' AND COALESCE(look, '') = ?").run(l.entity, l.look ?? "");
      db.prepare(`INSERT INTO plot_image (entity_id, url, source, label, look, anilist_id, from_ep, checked, updated_at) VALUES (?, ?, 'frame', ?, ?, ?, ?, 'frame', ?)`)
        .run(l.entity, url, l.label === "обычный" ? null : l.label, l.look, anilistId, l.ep, now());
      found++;
    }
    const per = (Date.now() - started) / 1000 / (i + 1);
    Object.assign(p, { done: i + 1, updatedAt: Date.now(), etaSec: Math.round(per * (looks.length - i - 1)) });
  }
  Object.assign(p, { step: "готово", finished: true, etaSec: 0, updatedAt: Date.now() });
  return { found, looks: looks.length, noVideo: [...noVideo].sort((a, b) => a - b) };
}

/** Файл кадра — только из папки тайтла (имя без путей). */
export async function frameFile(anilistId: number, name: string): Promise<Buffer | null> {
  if (!/^[\w-]+\.jpg$/.test(name)) return null;
  const f = path.join(DIR(), String(anilistId), "frames", name);
  return fs.existsSync(f) ? readFile(f) : null;
}

registerHandler("frames", {
  noun: "Кадры персонажей готовы",
  anilistId: async (key) => Number(key) || null,
  title: async (key) => {
    const d = await getDetails(Number(key));
    return d.title.romaji ?? d.title.english ?? `#${key}`;
  },
  fresh: () => false,
  href: (key) => `/anime/${key}/characters`,
  run: async (key, signal) => {
    const r = await findFrames(Number(key), signal);
    const miss = r.noVideo.length ? ` · нет видео серий ${r.noVideo.join(", ")}` : "";
    return { summary: `Кадров: ${r.found} из ${r.looks} обликов${miss}`, isNew: r.found > 0 };
  },
});
