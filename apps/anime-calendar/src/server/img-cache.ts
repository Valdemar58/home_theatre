import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { IMG_SIZES, isCacheable, type ImgSize } from "@/lib/img";
import { db, now } from "./db";
import { env } from "./env";

// Кэш картинок: клиент берёт картинки у нас, а не у AniList/Shikimori/TMDB.
// Оригинал качается один раз (в максимальном размере), уменьшенные копии делает sharp по запросу.
// Очистка поэтапная: копии без запросов 14 дн → удалить; оригинал без запросов 90 дн → удалить
// вместе с копиями; сверх 5 ГБ — давно не нужные первыми.

const DIR = () => path.join(env.dataDir, "img-cache");
const DAY = 86400;
export const LIMITS = { variantTtl: 14 * DAY, originalTtl: 90 * DAY, maxBytes: 5 * 1024 ** 3 };
// Результаты ИИ-апскейла дороги (секунды GPU) — храним дольше во столько раз (.env IMG_UPSCALE_TTL_MULT)
export const UPSCALE_TTL_MULT = Math.max(1, Number(process.env.IMG_UPSCALE_TTL_MULT) || 4);
// last_access пишем не чаще раза в час на картинку — без записи в базу на каждый запрос
const TOUCH_EVERY = 3600;

type Row = { key: string; variant: string; file: string; content_type: string; bytes: number; last_access: number };

// v2 — оригиналы в максимальном размере (AniList extraLarge); v3 — ключ по адресу оригинала:
// обложка AniList по адресу medium/… и large/… — одна картинка (один файл, один апскейл)
export const keyOf = (url: string) => createHash("sha1").update(`v3|${originalUrl(url)}`).digest("hex");

/**
 * Адрес оригинала в максимальном размере:
 * TMDB /t/p/w342/… → /t/p/original/…; AniList cover/medium (230px, это их «large») → cover/large (extraLarge, 460px).
 */
export function originalUrl(url: string): string {
  return url
    .replace(/(image\.tmdb\.org\/t\/p\/)[a-z0-9]+\//, "$1original/")
    .replace(/(anilistcdn\/media\/anime\/cover\/)(?:small|medium)\//, "$1large/");
}

const inflight = new Map<string, Promise<Row>>();
const once = (id: string, fn: () => Promise<Row>) => {
  const running = inflight.get(id);
  if (running) return running;
  const p = fn().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
};

const getRow = (key: string, variant: string) =>
  db.prepare<[string, string], Row>("SELECT * FROM img_cache WHERE key = ? AND variant = ?").get(key, variant);

function saveRow(key: string, variant: string, url: string, file: string, type: string, bytes: number) {
  db.prepare(
    `INSERT INTO img_cache (key, variant, url, file, content_type, bytes, created_at, last_access) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, variant) DO UPDATE SET file = excluded.file, content_type = excluded.content_type,
       bytes = excluded.bytes, last_access = excluded.last_access`,
  ).run(key, variant, url, file, type, bytes, now(), now());
}

function touch(row: Row) {
  if (now() - row.last_access > TOUCH_EVERY) {
    db.prepare("UPDATE img_cache SET last_access = ? WHERE key = ? AND variant = ?").run(now(), row.key, row.variant);
  }
}

async function fetchOriginal(key: string, url: string): Promise<Row> {
  return once(`${key}:orig`, async () => {
    const get = (u: string) => fetch(u, {
      // CDN Fandom отдаёт картинку только со ссылкой с вики (иначе 403)
      headers: { "User-Agent": "Mozilla/5.0 (anime-calendar image cache)", Accept: "image/*", ...(u.includes("wikia.nocookie.net") ? { Referer: "https://www.fandom.com/" } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    // Крупной версии может не быть (старые обложки AniList «b12345-…» — только medium) — тогда как есть
    let res = await get(originalUrl(url));
    if (res.status === 404 && originalUrl(url) !== url) res = await get(url);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) throw new Error(`картинка недоступна: HTTP ${res.status} ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(key.slice(0, 2), `${key}.orig`);
    await mkdir(path.join(DIR(), key.slice(0, 2)), { recursive: true });
    await writeFile(path.join(DIR(), file), buf);
    saveRow(key, "orig", url, file, type, buf.length);
    return getRow(key, "orig")!;
  });
}

async function makeVariant(key: string, url: string, size: Exclude<ImgSize, "full">, orig: Row, name: string = size): Promise<Row> {
  return once(`${key}:${name}`, async () => {
    const input = await readFile(path.join(DIR(), orig.file));
    // Не увеличиваем: маленький оригинал отдаётся как есть, но в WebP
    const out = await sharp(input, { animated: false }).rotate()
      .resize({ width: IMG_SIZES[size], withoutEnlargement: true })
      .webp({ quality: size === "tiny" ? 50 : size === "thumb" ? 72 : 80 })
      .toBuffer();
    const file = path.join(key.slice(0, 2), `${key}.${name}.webp`);
    await writeFile(path.join(DIR(), file), out);
    saveRow(key, name, url, file, "image/webp", out.length);
    return getRow(key, name)!;
  });
}

/** Картинка из кэша (скачать/уменьшить при первом запросе). upscaled — версия после ИИ-апскейла, если она готова. */
export async function cachedImage(url: string, size: ImgSize, opts: { upscaled?: boolean } = {}): Promise<{ body: Buffer; type: string; etag: string; upscaled: boolean }> {
  if (!isCacheable(url)) throw new Error("источник картинок не разрешён");
  const key = keyOf(url);
  let orig = getRow(key, "orig");
  const read = async (row: Row) => ({
    body: await readFile(path.join(DIR(), row.file)), type: row.content_type, etag: `"${key}-${row.variant}"`, upscaled: row.variant.startsWith("up"),
  });

  const up = opts.upscaled ? getRow(key, "up") : undefined;
  if (up) {
    try {
      touch(up);
      if (size === "full") return await read(up);
      const v = getRow(key, `up-${size}`);
      if (v) { touch(v); return await read(v); }
      return await read(await makeVariant(key, url, size, up, `up-${size}`));
    } catch {
      /* файл пропал — отдадим обычную */
    }
  }

  if (size !== "full") {
    const v = getRow(key, size);
    if (v) {
      try {
        touch(v);
        if (orig) touch(orig);
        return await read(v);
      } catch {
        /* файл пропал — пересоздадим */
      }
    }
  }
  if (orig) {
    try {
      touch(orig);
      if (size === "full") return await read(orig);
    } catch {
      orig = undefined;
    }
  }
  if (!orig) orig = await fetchOriginal(key, url);
  if (size === "full") return read(orig);
  return read(await makeVariant(key, url, size, orig));
}

/** Оригинал в кэше (скачать при необходимости): путь к файлу и ширина — для ИИ-апскейла. */
export async function originalFile(url: string): Promise<{ key: string; file: string; width: number }> {
  const key = keyOf(url);
  let orig = getRow(key, "orig");
  if (!orig) orig = await fetchOriginal(key, url);
  const file = path.join(DIR(), orig.file);
  const meta = await sharp(file).metadata();
  return { key, file, width: meta.width ?? 0 };
}

/** Вход для апскейлера: PNG без альфа-канала (Real-ESRGAN портит прозрачность — выходило чёрное). */
export async function upscaleInput(file: string): Promise<Buffer> {
  return sharp(file).removeAlpha().png().toBuffer();
}

/** Сохранить результат ИИ-апскейла (WebP q95; старые копии up-* удаляются — пересоздадутся из нового). */
export async function saveUpscaled(url: string, image: Buffer, maxWidth: number): Promise<{ bytes: number; width: number }> {
  const key = keyOf(url);
  // Альфа-канал не храним: обложки непрозрачные, а модель его портит (картинка становилась чёрной)
  const out = await sharp(image).removeAlpha().resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 95 }).toBuffer();
  const file = path.join(key.slice(0, 2), `${key}.up.webp`);
  await mkdir(path.join(DIR(), key.slice(0, 2)), { recursive: true });
  await writeFile(path.join(DIR(), file), out);
  for (const r of db.prepare<[string], Row>("SELECT * FROM img_cache WHERE key = ? AND variant LIKE 'up-%'").all(key)) {
    await rm(path.join(DIR(), r.file), { force: true });
    db.prepare("DELETE FROM img_cache WHERE key = ? AND variant = ?").run(key, r.variant);
  }
  saveRow(key, "up", url, file, "image/webp", out.length);
  return { bytes: out.length, width: (await sharp(out).metadata()).width ?? 0 };
}

export const hasUpscaled = (url: string) => Boolean(getRow(keyOf(url), "up"));

/** Поэтапная очистка (из jobs.ts). */
export async function cleanupImages(): Promise<{ removed: number; freed: number }> {
  let removed = 0;
  let freed = 0;
  const drop = async (rows: Row[]) => {
    for (const r of rows) {
      await rm(path.join(DIR(), r.file), { force: true });
      db.prepare("DELETE FROM img_cache WHERE key = ? AND variant = ?").run(r.key, r.variant);
      removed++;
      freed += r.bytes;
    }
  };
  const t = now();
  const m = UPSCALE_TTL_MULT;
  // 1) уменьшенные копии без запросов (копии апскейла — в m раз дольше)
  await drop(db.prepare<[number], Row>("SELECT * FROM img_cache WHERE variant NOT IN ('orig', 'up') AND variant NOT LIKE 'up-%' AND last_access < ?").all(t - LIMITS.variantTtl));
  await drop(db.prepare<[number], Row>("SELECT * FROM img_cache WHERE variant LIKE 'up-%' AND last_access < ?").all(t - LIMITS.variantTtl * m));
  // 2) оригиналы без запросов (с копиями) — по последнему обращению к любой версии; с апскейлом — в m раз дольше
  const stale = db.prepare<[number, number], { key: string }>(
    `SELECT key FROM img_cache GROUP BY key HAVING MAX(last_access) < CASE WHEN SUM(variant = 'up') > 0 THEN ? ELSE ? END`)
    .all(t - LIMITS.originalTtl * m, t - LIMITS.originalTtl);
  for (const { key } of stale) await drop(db.prepare<[string], Row>("SELECT * FROM img_cache WHERE key = ?").all(key));
  // 3) потолок размера: давно не нужные картинки целиком
  let total = db.prepare<[], { s: number | null }>("SELECT SUM(bytes) s FROM img_cache").get()?.s ?? 0;
  if (total > LIMITS.maxBytes) {
    const lru = db.prepare<[], { key: string; bytes: number }>(
      "SELECT key, SUM(bytes) bytes FROM img_cache GROUP BY key ORDER BY MAX(last_access)").all();
    for (const { key, bytes } of lru) {
      if (total <= LIMITS.maxBytes * 0.9) break;
      await drop(db.prepare<[string], Row>("SELECT * FROM img_cache WHERE key = ?").all(key));
      total -= bytes;
    }
  }
  return { removed, freed };
}

