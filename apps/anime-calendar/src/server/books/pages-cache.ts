import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { providerById } from "./library";
import { providerConfig } from "./provider-config";

// Картинки глав (страницы манги, иллюстрации ранобэ) через календарь: провайдеры отдают их только с Referer своего
// сайта, а браузеру не нужно знать адреса. Свой кэш на диске (DATA_DIR/pages), отдельно от кэша обложек:
// страниц много и они тяжёлые — лимит PAGES_CACHE_GB (по умолчанию 5), сначала уходят давно открытые.

const DIR = () => path.join(env.dataDir, "pages");
const LIMIT = () => (Number(process.env.PAGES_CACHE_GB) > 0 ? Number(process.env.PAGES_CACHE_GB) : 5) * 1024 ** 3;

/** Откуда можно брать картинки (адрес приходит из браузера — не прокси для чего угодно). */
const ALLOWED = /(^|\.)(imglib\.info|cdnlibs\.org|mangalib\.me|ranobelib\.me|mangadex\.org|mangadex\.network|syosetu\.com)$/;

export function allowedImage(url: string, provider?: string): boolean {
  try {
    const u = new URL(url);
    if (provider) {
      const p = providerById(provider);
      if (provider === "suwayomi") {
        const base = new URL(providerConfig().suwayomi.url);
        return u.origin === base.origin && /^\/api\/v1\/manga\/[0-9]+\/chapter\/[0-9]+\/page\/[0-9]+$/.test(u.pathname) && !u.username && !u.password;
      }
      if (p?.imageHost) return p.imageHost(u.hostname, u.protocol);
    }
    return u.protocol === "https:" && ALLOWED.test(u.hostname);
  } catch {
    return false;
  }
}

/** Адрес картинки главы для браузера. */
export const pageUrl = (provider: string, url: string) => `/api/books/page?p=${encodeURIComponent(provider)}&u=${encodeURIComponent(url)}`;

const fileOf = (url: string) => {
  const h = createHash("sha1").update(url).digest("hex");
  return path.join(DIR(), h.slice(0, 2), h);
};

/** Картинка: с диска или от провайдера (с его Referer), сохраняется. */
export async function pageImage(provider: string, url: string): Promise<{ body: Buffer; type: string }> {
  const f = fileOf(url);
  try {
    const body = fs.readFileSync(f);
    const now = new Date();
    fs.utimesSync(f, now, now);
    return { body, type: fs.readFileSync(`${f}.type`, "utf8") };
  } catch { /* нет на диске */ }
  const p = providerById(provider);
  if (!allowedImage(url, provider)) throw new Error("Картинка не с сайта провайдера");
  const res = await fetch(url, { redirect: provider === "suwayomi" ? "error" : "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140", ...(p?.imageHeaders ?? {}) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`картинка ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "image/jpeg";
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  fs.writeFileSync(`${f}.type`, type);
  return { body, type };
}

/** Уборка: сверх лимита — сначала давно открытые (из jobs.ts). */
export function cleanupPages() {
  const files: { f: string; size: number; at: number }[] = [];
  let total = 0;
  if (!fs.existsSync(DIR())) return;
  for (const d of fs.readdirSync(DIR())) {
    for (const name of fs.readdirSync(path.join(DIR(), d))) {
      if (name.endsWith(".type")) continue;
      const f = path.join(DIR(), d, name);
      const st = fs.statSync(f);
      files.push({ f, size: st.size, at: st.mtimeMs });
      total += st.size;
    }
  }
  if (total <= LIMIT()) return;
  files.sort((a, b) => a.at - b.at);
  for (const x of files) {
    if (total <= LIMIT() * 0.9) break;
    fs.rmSync(x.f, { force: true });
    fs.rmSync(`${x.f}.type`, { force: true });
    total -= x.size;
  }
}
