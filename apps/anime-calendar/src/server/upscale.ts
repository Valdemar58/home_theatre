import "server-only";
import { EventEmitter } from "node:events";
import { planUpscale, UPSCALE_MODELS, type UpscaleConfig } from "@/lib/upscale-plan";
import { IMG_SIZES, isCacheable } from "@/lib/img";
import { db, now } from "./db";
import { hasUpscaled, keyOf, originalFile, saveUpscaled, upscaleInput } from "./img-cache";
import { llmBusy } from "./llm";

// ИИ-апскейл картинок (контейнер upscaler, Real-ESRGAN). Страница не ждёт: клиент спрашивает
// состояние пачкой (/api/img/status) — это же ставит картинки в очередь; готовые прилетают
// событием (/api/img/events), и открытые вкладки сами подменяют картинку.
// Нет контейнера — состояние «none», всё работает как раньше (лучший оригинал).
// Очередь одна и последовательная (свежие запросы — первыми), дубликаты не ставятся; пока занята LLM — ждём (видеокарта одна).

export type UpState = "done" | "pending" | "none";

const URL_ = (process.env.UPSCALER_URL ?? "").replace(/\/+$/, "");
export const UPSCALE_CONFIG: UpscaleConfig = {
  model: process.env.IMG_UPSCALE_MODEL || "realesr-animevideov3",
  target: Number(process.env.IMG_UPSCALE_TARGET) || 1000,
  maxScale: Number(process.env.IMG_UPSCALE_MAX_SCALE) || 4,
  minSrc: Number(process.env.IMG_UPSCALE_MIN_SRC) || 150,
};

type Row = { key: string; url: string; state: string; model: string | null; scale: number | null; src_w: number | null; out_w: number | null; ms: number | null; error: string | null; target: number | null; updated_at: number };

export const upscaleEvents = new EventEmitter();
upscaleEvents.setMaxListeners(0);

// ---------------------------------------------------------------- доступность

let health: { ok: boolean; device: string | null; at: number } | null = null;

export async function upscalerHealth(): Promise<{ ok: boolean; device: string | null }> {
  if (!URL_) return { ok: false, device: null };
  if (health && Date.now() - health.at < 60_000) return health;
  try {
    const r = await fetch(`${URL_}/health`, { signal: AbortSignal.timeout(3000) });
    const d = (await r.json()) as { ok: boolean; device: string };
    health = { ok: r.ok && d.ok, device: d.device, at: Date.now() };
  } catch {
    health = { ok: false, device: null, at: Date.now() };
  }
  return health;
}

/** Один вызов апскейлера (очередь и лаборатория). */
export async function callUpscaler(image: Buffer, model: string, scale: number): Promise<{ png: Buffer; ms: number }> {
  const r = await fetch(`${URL_}/upscale?model=${encodeURIComponent(model)}&scale=${scale}`, {
    method: "POST", body: new Uint8Array(image), signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`апскейлер: ${(await r.text()).slice(0, 300)}`);
  return { png: Buffer.from(await r.arrayBuffer()), ms: Number(r.headers.get("x-elapsed-ms")) || 0 };
}

// ---------------------------------------------------------------- состояние и очередь

/** Размер показа → нужная ширина: карточке хватает 480px (обложки AniList 460 — без апскейла), крупно — цель из .env. */
export type UpSize = "card" | "full";
export const targetFor = (size: UpSize) => (size === "card" ? IMG_SIZES.card : UPSCALE_CONFIG.target);
/** Исходник не меньше 90% нужного — апскейл не нужен (разницы не видно). */
const ENOUGH = 0.9;

const getRow = (key: string) => db.prepare<[string], Row>("SELECT * FROM img_upscale WHERE key = ?").get(key);
const setRow = (key: string, url: string, patch: Partial<Row> & { state: string }) => {
  const r = getRow(key);
  const v = { model: null, scale: null, src_w: null, out_w: null, ms: null, error: null, target: null, ...r, ...patch };
  db.prepare(`INSERT INTO img_upscale (key, url, state, model, scale, src_w, out_w, ms, error, target, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET url = excluded.url, state = excluded.state, model = excluded.model, scale = excluded.scale, src_w = excluded.src_w,
      out_w = excluded.out_w, ms = excluded.ms, error = excluded.error, target = excluded.target, updated_at = excluded.updated_at`)
    .run(key, url, v.state, v.model, v.scale, v.src_w, v.out_w, v.ms, v.error, v.target, now());
};

/** Очередь: ключ → адрес и нужная ширина (повторный запрос с большей целью её поднимает). */
const queue: string[] = [];
const wanted = new Map<string, { url: string; target: number }>();
let running = false;
let recovered = false;
const widths = new Map<string, number>();

async function widthOf(url: string): Promise<number> {
  const key = keyOf(url);
  if (!widths.has(key)) widths.set(key, (await originalFile(url)).width);
  return widths.get(key)!;
}

/** Состояние одной картинки для показа размера size; подходящая и не готовая — в очередь. */
async function statusOne(url: string, size: UpSize, ok: boolean): Promise<UpState> {
  if (!isCacheable(url)) return "none";
  const key = keyOf(url);
  const target = targetFor(size);
  const r = getRow(key);
  const done = r?.state === "done" && hasUpscaled(url);
  if (done && (r.out_w ?? 0) >= target * ENOUGH) return "done";
  const width = await widthOf(url).catch(() => 0);
  if (!width) return done ? "done" : "none";
  // Исходника хватает — апскейл не нужен (готовый, если есть, всё равно покажем)
  if (width >= target * ENOUGH) return done ? "done" : "none";
  if (!planUpscale(width, { ...UPSCALE_CONFIG, target })) return done ? "done" : "none";
  // Уже падал на этой модели и цели — не повторяем
  if (r?.state === "failed" && r.model === UPSCALE_CONFIG.model && (r.target ?? 0) >= target) return done ? "done" : "none";
  if (!ok) return done ? "done" : "none";
  const w = wanted.get(key);
  if (!w) {
    wanted.set(key, { url, target });
    queue.push(key);
    setRow(key, url, { state: "queued", target });
  } else if (w.target < target) {
    w.target = target;
  }
  return done ? "done" : "pending";
}

/** Состояния картинок пачкой («<размер>:<адрес>» → состояние). */
export async function upscaleStatus(items: { url: string; size: UpSize }[]): Promise<Record<string, UpState>> {
  const { ok } = await upscalerHealth();
  if (!recovered) {
    recovered = true;
    // Прерванные рестартом — заново
    db.prepare("UPDATE img_upscale SET state = 'new' WHERE state IN ('queued', 'running')").run();
  }
  const out: Record<string, UpState> = {};
  for (const it of items) out[`${it.size}:${it.url}`] = await statusOne(it.url, it.size, ok);
  void drain();
  return out;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // Видеокарта одна: пока LLM считает рекомендации или анализ — ждём
      while (llmBusy()) await new Promise((r) => setTimeout(r, 5000));
      // Последний запрошенный — первым: это то, что пользователь смотрит прямо сейчас
      // (открыл тайтл после долгой прокрутки каталога — его постер не ждёт всю ленту)
      const key = queue.pop()!;
      const w = wanted.get(key);
      wanted.delete(key);
      if (w) await processOne(w.url, w.target).catch((e) => console.warn(`[upscale] ${w.url}: ${String(e)}`));
    }
  } finally {
    running = false;
  }
}

async function processOne(url: string, target: number) {
  const key = keyOf(url);
  const c = UPSCALE_CONFIG;
  try {
    const src = await originalFile(url);
    const scale = planUpscale(src.width, { ...c, target });
    if (!scale) {
      setRow(key, url, { state: "skipped", model: c.model, src_w: src.width, target });
      upscaleEvents.emit("change", { url, state: "none" });
      return;
    }
    setRow(key, url, { state: "running", model: c.model, scale, src_w: src.width, target });
    const { png, ms } = await callUpscaler(await upscaleInput(src.file), c.model, scale);
    const saved = await saveUpscaled(url, png, target);
    setRow(key, url, { state: "done", model: c.model, scale, src_w: src.width, out_w: saved.width, ms, error: null, target });
    upscaleEvents.emit("change", { url, state: "done" });
  } catch (e) {
    // Апскейлер недоступен (остановили, перезапуск) — не ошибка картинки: повторим при следующем показе
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|aborted/i.test(String(e))) {
      health = null;
      setRow(key, url, { state: "new" });
      upscaleEvents.emit("change", { url, state: "none" });
      return;
    }
    setRow(key, url, { state: "failed", model: c.model, error: String(e).slice(0, 300), target });
    upscaleEvents.emit("change", { url, state: "none" });
    throw e;
  }
}

/** Как сделан апскейл картинки (для лаборатории). */
export function upscaleInfo(url: string) {
  return getRow(keyOf(url)) ?? null;
}

/** Сводка для лаборатории. */
export function upscaleStats() {
  const rows = db.prepare<[], { state: string; n: number; ms: number | null }>(
    "SELECT state, COUNT(*) n, AVG(ms) ms FROM img_upscale GROUP BY state").all();
  const recent = db.prepare<[], Row>("SELECT * FROM img_upscale WHERE state = 'done' ORDER BY updated_at DESC LIMIT 24").all();
  const bytes = db.prepare<[], { b: number | null }>("SELECT SUM(bytes) b FROM img_cache WHERE variant = 'up' OR variant LIKE 'up-%'").get()?.b ?? 0;
  return { byState: rows, recent, bytes, queue: queue.length, config: UPSCALE_CONFIG, models: UPSCALE_MODELS };
}
