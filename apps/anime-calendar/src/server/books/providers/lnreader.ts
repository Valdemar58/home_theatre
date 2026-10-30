import "server-only";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import * as htmlparser2 from "htmlparser2";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { htmlToBlocks, parseNum, type ChapterRow } from "@/lib/books";
import { cached, getCached } from "../../cache";
import { env } from "../../env";
import { RateLimiter } from "../../http";
import { guarded } from "../../sources";
import { providerConfig } from "../provider-config";
import { searchQueries, type Hit, type Provider } from "./types";

// Мост к плагинам LNReader (TASKS 5.9): десятки сайтов ранобэ (Rulate, Автор Тудей, английские и китайские) — их JS из
// открытого репозитория LNReader. Плагин выполняется в отдельном контексте vm: вместо модулей приложения — свои замены
// (@libs/fetch, storage, novelStatus…), настоящие cheerio, htmlparser2, dayjs; ни process, ни require Node. Это не
// песочница безопасности (тот же процесс), а граница от случайных обращений: код — из открытого репозитория.
// Книга у провайдера — «<плагин>::<путь>», глава — «<плагин>::<путь главы>». Включённые плагины — в настройках.

export type PluginMeta = { id: string; name: string; site: string; lang: string; version: string; url: string; iconUrl?: string };

const LANGS: Record<string, string> = {
  "Русский": "ru", "English": "en", "日本語": "ja", "中文, 汉语, 漢語": "zh", "조선말, 한국어": "ko", "Українська": "uk", "Español": "es",
  "Português": "pt-br", "Français": "fr", "Bahasa Indonesia": "id", "Tiếng Việt": "vi", "Polski": "pl", "Türkçe": "tr", "ไทย": "th",
};
export const pluginLang = (m: Pick<PluginMeta, "lang">) => LANGS[m.lang.replace(/‎/g, "").trim()] ?? "en";

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Mobile Safari/537.36";
const limiters = new Map<string, RateLimiter>();
const limiterOf = (host: string) => limiters.get(host) ?? (limiters.set(host, new RateLimiter(400)), limiters.get(host)!);

/** Индекс плагинов (раз в сутки). */
export function pluginIndex(): Promise<PluginMeta[]> {
  const url = providerConfig().lnreader.index;
  return cached(`lnr-index:${url}`, { fresh: 86400, source: "lnreader" }, () => guarded("lnreader", async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`индекс плагинов: ${r.status}`);
    return (await r.json()) as PluginMeta[];
  }));
}

async function enabledPlugins(): Promise<PluginMeta[]> {
  const ids = providerConfig().lnreader.plugins;
  if (!ids.length) return [];
  return (await pluginIndex()).filter((p) => ids.includes(p.id));
}

// ---------------------------------------------------------------- окружение плагина

const defaultHeaders = { Connection: "keep-alive", Accept: "*/*", "Accept-Language": "*", "Accept-Encoding": "gzip, deflate", "User-Agent": UA };
type FetchInit = { headers?: Record<string, string | undefined> | Headers; method?: string; body?: unknown; [k: string]: unknown };

async function pluginFetch(url: string, init?: FetchInit): Promise<Response> {
  const h = new Headers(defaultHeaders);
  if (init?.headers instanceof Headers) init.headers.forEach((v, k) => h.set(k, v));
  else for (const [k, v] of Object.entries(init?.headers ?? {})) if (v !== undefined) h.set(k, v);
  return limiterOf(new URL(url).host).run(() => fetch(url, { ...(init as RequestInit), headers: h, signal: AbortSignal.timeout(30_000) }));
}

class PluginStorage {
  private db: Record<string, { created: Date; value: unknown; expires?: number }> = {};
  set(key: string, value: unknown, expires?: Date | number) { this.db[key] = { created: new Date(), value, expires: expires instanceof Date ? expires.getTime() : expires }; }
  get(key: string, raw?: boolean) {
    const it = this.db[key];
    if (it?.expires && Date.now() > it.expires) { delete this.db[key]; return undefined; }
    return raw ? it : it?.value;
  }
  getAllKeys() { return Object.keys(this.db); }
  delete(key: string) { delete this.db[key]; }
  clearAll() { this.db = {}; }
}

function libsFor(): Record<string, unknown> {
  const store = new PluginStorage();
  const web = { get: () => ({}) };
  return {
    "@libs/fetch": {
      fetchApi: pluginFetch,
      fetchText: async (url: string, init?: FetchInit, encoding?: string) => {
        try {
          const r = await pluginFetch(url, init);
          return r.ok ? new TextDecoder(encoding).decode(await r.arrayBuffer()) : "";
        } catch { return ""; }
      },
      fetchFile: async (url: string, init?: FetchInit) => {
        try {
          const r = await pluginFetch(url, init);
          return r.ok ? Buffer.from(await r.arrayBuffer()).toString("base64") : "";
        } catch { return ""; }
      },
      fetchProto: async () => { throw new Error("fetchProto не поддерживается"); },
    },
    "@libs/novelStatus": { NovelStatus: { Unknown: "Unknown", Ongoing: "Ongoing", Completed: "Completed", Licensed: "Licensed", PublishingFinished: "Publishing Finished", Cancelled: "Cancelled", OnHiatus: "On Hiatus", STUB: "STUB", Inactive: "Inactive" } },
    "@libs/defaultCover": { defaultCover: "" },
    "@libs/storage": { storage: store, localStorage: web, sessionStorage: web },
    "@libs/filterInputs": { FilterTypes: { TextInput: "Text", Picker: "Picker", CheckboxGroup: "Checkbox", Switch: "Switch", ExcludableCheckboxGroup: "XCheckbox" } },
    "@libs/isAbsoluteUrl": { isUrlAbsolute: (u: string) => Boolean(u) && (u.startsWith("//") || u.includes("://")) },
    cheerio, htmlparser2, dayjs: Object.assign(dayjs, { default: dayjs }),
  };
}

type LnPlugin = {
  id: string; name: string; site: string;
  searchNovels(term: string, page: number): Promise<{ name: string; path: string; cover?: string }[]>;
  parseNovel(path: string): Promise<{ name: string; path: string; cover?: string; summary?: string; chapters?: { name: string; path: string; releaseTime?: string | null; chapterNumber?: number; scanlator?: string | string[] }[]; totalPages?: number }>;
  parsePage?(path: string, page: string): Promise<{ chapters: { name: string; path: string; releaseTime?: string | null; chapterNumber?: number }[] }>;
  parseChapter(path: string): Promise<string>;
  resolveUrl?(path: string, isNovel?: boolean): string;
};

const g = globalThis as unknown as { __lnPlugins?: Map<string, Promise<LnPlugin>> };
const loaded = (g.__lnPlugins ??= new Map());

/** Код плагина — с диска (DATA_DIR/lnreader/<id>@<версия>.js), нет — скачать. */
async function pluginCode(m: PluginMeta): Promise<string> {
  const dir = path.join(env.dataDir, "lnreader");
  const file = path.join(dir, `${m.id.replace(/[^\w.-]/g, "_")}@${m.version}.js`);
  try { return fs.readFileSync(file, "utf8"); } catch { /* нет на диске */ }
  const r = await fetch(m.url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`плагин ${m.name}: ${r.status}`);
  const code = await r.text();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, code);
  return code;
}

function loadPlugin(m: PluginMeta): Promise<LnPlugin> {
  const key = `${m.id}@${m.version}`;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      const code = await pluginCode(m);
      const libs = libsFor();
      const mod = { exports: {} as Record<string, unknown> };
      const quiet = { log: () => undefined, info: () => undefined, debug: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.warn(`[lnreader:${m.id}]`, ...a) };
      const ctx = vm.createContext({
        module: mod, exports: mod.exports, console: quiet,
        require: (name: string) => {
          if (name in libs) return libs[name];
          throw new Error(`модуль ${name} недоступен плагину`);
        },
        fetch: pluginFetch, URL, URLSearchParams, TextDecoder, TextEncoder, Headers, FormData, Request, Response, AbortController, Blob,
        setTimeout, clearTimeout, atob, btoa, Buffer,
      });
      vm.runInContext(code, ctx, { timeout: 5000, filename: `${m.id}.js` });
      const plugin = (mod.exports.default ?? (ctx.exports as Record<string, unknown>)?.default) as LnPlugin | undefined;
      if (!plugin?.searchNovels) throw new Error(`плагин ${m.name} не загрузился`);
      return plugin;
    })();
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}

/** Вызов плагина с пределом времени (зависший сайт не держит оглавление книги). */
const within = <T,>(p: Promise<T>, ms = 90_000) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("плагин не ответил вовремя")), ms))]);

const split = (ref: string) => {
  const i = ref.indexOf("::");
  return { id: ref.slice(0, i), path: ref.slice(i + 2) };
};

async function pluginFor(id: string): Promise<{ meta: PluginMeta; plugin: LnPlugin }> {
  const meta = (await pluginIndex()).find((p) => p.id === id);
  if (!meta) throw new Error(`плагина ${id} нет в индексе`);
  return { meta, plugin: await loadPlugin(meta) };
}

const absolute = (site: string, u: string) => { try { return new URL(u, site).toString(); } catch { return u; } };

export const lnreader: Provider = {
  id: "lnreader",
  name: "LNReader",
  kinds: ["novel"],
  langs: ["ru", "en", "ja", "zh", "ko"],
  source: "lnreader",
  bookUrl: (ref) => {
    const { id, path: p } = split(ref);
    const meta = getCached<PluginMeta[]>(`lnr-index:${providerConfig().lnreader.index}`, true)?.find((x) => x.id === id);
    return meta ? absolute(meta.site, p) : p;
  },
  // Картинки — с сайтов плагинов (и их CDN): любой внешний https, не адреса внутри сети
  imageHost: (host, protocol) => protocol === "https:" && host.includes(".") && !/^(\d+\.){3}\d+$/.test(host) && !/\.(local|internal|lan)$/.test(host),
  ping: async () => { await pluginIndex(); },

  async search(book, query) {
    const plugins = await enabledPlugins();
    const hits: Hit[] = [];
    await Promise.all(plugins.map(async (m) => {
      try {
        const plugin = await loadPlugin(m);
        const seen = new Set<string>();
        for (const q of searchQueries(book, query, 2)) {
          const found = await cached(`lnr-search:${m.id}:${q.toLowerCase()}`, { fresh: 86400, source: "lnreader" },
            () => within(plugin.searchNovels(q, 1)));
          for (const n of found.slice(0, 8)) {
            if (seen.has(n.path)) continue;
            seen.add(n.path);
            hits.push({
              // «Название [перевод команды]» — для сравнения без пометок в скобках
              provider: "lnreader", ref: `${m.id}::${n.path}`, title: n.name, titles: [...new Set([n.name, n.name.replace(/\s*\[[^\]]*\]\s*/g, " ").trim()])], year: null,
              cover: n.cover ? absolute(m.site, n.cover) : null, url: absolute(m.site, n.path), edition: "web",
              note: `${m.name} · ${m.lang.replace(/‎/g, "")}`,
            });
          }
        }
      } catch (e) {
        console.warn(`[lnreader] ${m.name}: ${String(e).slice(0, 200)}`);
      }
    }));
    return hits;
  },

  async chapters(ref) {
    const { id, path: p } = split(ref);
    const { meta, plugin } = await pluginFor(id);
    const novel = await within(plugin.parseNovel(p), 120_000);
    let list = novel.chapters ?? [];
    if (novel.totalPages && plugin.parsePage) {
      for (let page = 1; page <= Math.min(novel.totalPages, 200); page++) list = list.concat((await within(plugin.parsePage(p, String(page)))).chapters);
    }
    const lang = pluginLang(meta);
    return list.map((c, i): ChapterRow => {
      const num = c.chapterNumber ?? parseNum(c.name.replace(/^.*?(глава|chapter|ch\.?|第)\s*/i, "")) ?? i + 1;
      const date = c.releaseTime ? Math.floor(Date.parse(c.releaseTime) / 1000) || null : null;
      const team = [meta.name, ...(Array.isArray(c.scanlator) ? c.scanlator : c.scanlator ? [c.scanlator] : [])].join(" · ");
      return { provider: "lnreader", ref, cref: `${id}::${c.path}`, edition: "web", lang, team, vol: null, num, numText: String(num), title: c.name, date };
    });
  },

  async content(_ref, cref) {
    const { id, path: p } = split(cref);
    const { meta, plugin } = await pluginFor(id);
    const html = await within(plugin.parseChapter(p));
    return { kind: "text", blocks: htmlToBlocks(html, (src) => absolute(meta.site, src)) };
  },
};
