import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canPrepare, DEFAULT_POLICY, GB, toEvict, type PrepItem, type PrepPolicy } from "@/lib/prep";
import { specsFromTorrServerDb, torrentFile } from "@/lib/torrent-file";
import { db, now } from "./db";
import { env } from "./env";
import { mappingForAnilist } from "./idmap";
import { notify } from "./notifications";
import { qbitAdd, qbitConfigured, qbitDelete, qbitFilePrio, qbitFiles, qbitStart, qbitTorrent, type QbitFile } from "./qbit";
import { strmEpisodes, streamAnilistId } from "./stream";
import { dropThumbs, ensureThumbs } from "./thumbs";

// «Подготовить серию» скачиванием (TASKS 9.8): файл раздачи «Стрима» целиком качает qBittorrent в STREAM_DIR/.prep/<хэш>/,
// готовую серию маршрутизатор потоков (apps/stream-router) отдаёт Jellyfin с диска вместо TorrServer — по тем же ссылкам
// .strm (их Jellyfin не перечитывает). Список готовых — .prep/index.json. Место ограничено (lib/prep.ts): досмотренные
// уходят через 3 дня, забытые — через 14, сверх лимита — по очереди. Нет .torrent или qBittorrent — прежний прогон
// через TorrServer (prebuffer.ts).

const PREP_DIR = () => path.join(env.streamDir, ".prep");
const TORRENTS_DIR = () => path.join(env.streamDir, ".torrents");
/** Та же папка глазами qBittorrent (DATA_ROOT смонтирован как /data) */
const QBIT_PREP = "/data/media/stream/.prep";
const TS_DB = "/torrserver/config.db";

export function prepPolicy(): PrepPolicy {
  const gb = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) * GB : d);
  return { ...DEFAULT_POLICY, limitBytes: gb(process.env.PREP_LIMIT_GB, DEFAULT_POLICY.limitBytes), minFreeBytes: gb(process.env.PREP_MIN_FREE_GB, DEFAULT_POLICY.minFreeBytes) };
}

type Row = { key: string; hash: string; idx: number; rel: string; size: number; anilist_id: number | null; ep: number | null; users: string; created_at: number; done_at: number | null };
const rows = () => db.prepare<[], Row>("SELECT * FROM prepared_files").all();
const rowOf = (key: string) => db.prepare<[string], Row>("SELECT * FROM prepared_files WHERE key = ?").get(key);

// ---------------------------------------------------------------- .torrent

/** Сохранить .torrent раздачи (при добавлении в TorrServer) — для скачивания серий qBittorrent. */
export function saveTorrent(hash: string, bytes: Uint8Array) {
  fs.mkdirSync(TORRENTS_DIR(), { recursive: true });
  fs.writeFileSync(path.join(TORRENTS_DIR(), `${hash}.torrent`), bytes);
}

/** .torrent раздачи: сохранённый или собранный из базы TorrServer (InfoBytes с проверкой SHA-1 и трекеры). */
function torrentBytes(hash: string): Uint8Array | null {
  const saved = path.join(TORRENTS_DIR(), `${hash}.torrent`);
  if (fs.existsSync(saved)) return fs.readFileSync(saved);
  if (!fs.existsSync(TS_DB)) return null;
  const spec = specsFromTorrServerDb(fs.readFileSync(TS_DB))
    .filter((s) => s.infoHash === hash && createHash("sha1").update(s.infoBytes).digest("hex") === hash)
    .sort((a, b) => b.trackers.flat().length - a.trackers.flat().length)[0];
  if (!spec) return null;
  const bytes = torrentFile(spec);
  saveTorrent(hash, bytes);
  return bytes;
}

// ---------------------------------------------------------------- готовые серии

/** Список готовых для маршрутизатора: {"<хэш>:<номер>": "<путь от .prep>"} (запись через временный файл). */
function writeIndex() {
  const ready = Object.fromEntries(rows().filter((r) => r.done_at !== null).map((r) => [r.key, r.rel]));
  fs.mkdirSync(PREP_DIR(), { recursive: true });
  const tmp = path.join(PREP_DIR(), "index.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(ready));
  fs.renameSync(tmp, path.join(PREP_DIR(), "index.json"));
}

/** Серия скачана целиком (её отдают с диска). */
export function isPrepared(hash: string, index: number): boolean {
  const r = rowOf(`${hash}:${index}`);
  return Boolean(r?.done_at && fs.existsSync(path.join(PREP_DIR(), r.rel)));
}

/** Файл скачанной серии на диске календаря (для миниатюр шкалы) или null. */
export function preparedPath(hash: string, index: number): string | null {
  const r = rowOf(`${hash}:${index}`);
  const p = r?.done_at ? path.join(PREP_DIR(), r.rel) : null;
  return p && fs.existsSync(p) ? p : null;
}

/** Скачанные серии раздачи: номер файла → доля (готовые — 1, качающиеся — по qBittorrent не спрашиваем, 0). */
export function preparedIndexes(hash: string): Set<number> {
  return new Set(db.prepare<[string], { idx: number }>("SELECT idx FROM prepared_files WHERE hash = ? AND done_at IS NOT NULL").all(hash).map((r) => r.idx));
}

const freeBytes = () => {
  try {
    const s = fs.statfsSync(env.streamDir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
};

/** Серия тайтла по коду S01E05 (для «досмотрели»); сквозная нумерация — не знаем (уйдёт по сроку). */
async function episodeOf(hash: string, index: number): Promise<{ anilistId: number | null; ep: number | null }> {
  const anilistId = await streamAnilistId(hash).catch(() => null);
  const code = strmEpisodes(hash).find((e) => e.index === index)?.code;
  const m = anilistId ? await mappingForAnilist(anilistId).catch(() => null) : null;
  const se = code ? /S(\d+)E(\d+)/.exec(code) : null;
  if (!anilistId || !m || !se || m.season === "a" || Number(se[1]) !== m.season) return { anilistId, ep: null };
  return { anilistId, ep: Number(se[2]) - m.offset };
}

const sameFile = (q: QbitFile, tsPath: string) => q.name.replace(/\\/g, "/") === tsPath.replace(/\\/g, "/");

export type DownloadResult = { mode: "download"; size: number } | { mode: "fallback"; reason: string };

/**
 * Скачать серию: qBittorrent качает только этот файл раздачи; onProgress — сколько скачано и скорость.
 * Нет .torrent, qBittorrent или места — fallback (подготовка пойдёт через TorrServer).
 */
export async function downloadEpisode(opts: {
  hash: string; index: number; file: { path: string; length: number }; userIds: number[]; signal: AbortSignal;
  onProgress: (read: number, speed: number) => void;
}): Promise<DownloadResult> {
  const { hash, index, file, signal } = opts;
  const key = `${hash}:${index}`;
  if (!qbitConfigured()) return { mode: "fallback", reason: "qBittorrent не настроен" };
  const existing = rowOf(key);
  if (existing?.done_at && isPrepared(hash, index)) {
    addUsers(key, opts.userIds);
    return { mode: "download", size: existing.size };
  }
  const bytes = torrentBytes(hash);
  if (!bytes) return { mode: "fallback", reason: "нет .torrent раздачи" };
  if (!existing) {
    await cleanupPrepared();
    const used = rows().reduce((s, r) => s + r.size, 0);
    const ok = canPrepare(file.length, used, freeBytes(), prepPolicy());
    if (!ok.ok) return { mode: "fallback", reason: ok.reason };
  }

  // Раздача в qBittorrent: новая — остановленной, чтобы до старта снять все файлы, кроме нужных. Снимаем и когда
  // своих серий у раздачи ещё нет (добавлена, а подготовка оборвалась): иначе качалась бы раздача целиком
  const fresh = !db.prepare<[string], { n: number }>("SELECT count(*) n FROM prepared_files WHERE hash = ?").get(hash)!.n;
  if (!(await qbitTorrent(hash))) await qbitAdd(bytes, `${QBIT_PREP}/${hash}`);
  let files: QbitFile[] = [];
  for (let i = 0; i < 30 && !files.length; i++) {
    files = await qbitFiles(hash).catch(() => []);
    if (!files.length) await new Promise((r) => setTimeout(r, 1000));
  }
  const target = files.find((f) => sameFile(f, file.path));
  if (!target) return { mode: "fallback", reason: "файл серии не найден в раздаче qBittorrent" };
  if (fresh) {
    // Остальные файлы не качать (кроме уже подготовленных серий этой раздачи — сверка по пути)
    const wanted = new Set(db.prepare<[string], { rel: string }>("SELECT rel FROM prepared_files WHERE hash = ?").all(hash).map((r) => r.rel));
    await qbitFilePrio(hash, files.filter((f) => f.index !== target.index && !wanted.has(`${hash}/${f.name.replace(/\\/g, "/")}`)).map((f) => f.index), 0);
  }
  await qbitFilePrio(hash, [target.index], 7);
  await qbitStart(hash);
  const { anilistId, ep } = existing ? { anilistId: existing.anilist_id, ep: existing.ep } : await episodeOf(hash, index);
  db.prepare(`INSERT INTO prepared_files (key, hash, idx, rel, size, anilist_id, ep, users, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
    ON CONFLICT(key) DO UPDATE SET rel = excluded.rel, size = excluded.size`)
    .run(key, hash, index, `${hash}/${target.name.replace(/\\/g, "/")}`, file.length, anilistId, ep, now());
  addUsers(key, opts.userIds);

  // Ждём, пока файл докачается (qBittorrent дописывает .!qB, пока не готов)
  const final = path.join(PREP_DIR(), hash, target.name);
  const onAbort = () => void dropOne(key).catch(() => undefined);
  signal.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal.aborted) throw new Error("отменено");
      const [f, t] = await Promise.all([qbitFiles(hash).then((l) => l.find((x) => x.index === target.index)), qbitTorrent(hash)]);
      if (!f || !t) throw new Error("раздача пропала из qBittorrent");
      opts.onProgress(Math.round(f.size * f.progress), t.dlspeed);
      if (f.progress >= 1 && fs.existsSync(final)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  db.prepare("UPDATE prepared_files SET done_at = ? WHERE key = ?").run(now(), key);
  writeIndex();
  // Миниатюры шкалы — сразу, пока серию не открыли (Jellyfin для «Стрима» их не делает)
  ensureThumbs(hash, index, final);
  return { mode: "download", size: file.length };
}

function addUsers(key: string, ids: number[]) {
  const r = rowOf(key);
  if (!r || !ids.length) return;
  const all = [...new Set([...(JSON.parse(r.users) as number[]), ...ids])];
  db.prepare("UPDATE prepared_files SET users = ? WHERE key = ?").run(JSON.stringify(all), key);
}

/** Убрать подготовленную серию: из списка маршрутизатора, из qBittorrent (не качать), файл — с диска. */
async function dropOne(key: string) {
  const r = rowOf(key);
  if (!r) return;
  db.prepare("DELETE FROM prepared_files WHERE key = ?").run(key);
  writeIndex();
  dropThumbs(r.hash, r.idx);
  const rest = db.prepare<[string], { n: number }>("SELECT count(*) n FROM prepared_files WHERE hash = ?").get(r.hash)!.n;
  if (!rest) {
    await qbitDelete(r.hash, true).catch((e) => console.warn(`[prep] удаление раздачи ${r.hash}: ${String(e)}`));
    fs.rmSync(path.join(PREP_DIR(), r.hash), { recursive: true, force: true });
    return;
  }
  const files = await qbitFiles(r.hash).catch(() => [] as QbitFile[]);
  const f = files.find((x) => `${r.hash}/${x.name.replace(/\\/g, "/")}` === r.rel);
  if (f) await qbitFilePrio(r.hash, [f.index], 0).catch(() => undefined);
  for (const p of [path.join(PREP_DIR(), r.rel), `${path.join(PREP_DIR(), r.rel)}.!qB`]) fs.rmSync(p, { force: true });
}

/** Уборка (раз в 30 мин и перед новой подготовкой): досмотренные, забытые, сверх лимита; серии без своей ссылки .strm. */
export async function cleanupPrepared(): Promise<void> {
  const all = rows();
  if (!all.length) return;
  const items: PrepItem[] = all.map((r) => {
    const users = JSON.parse(r.users) as number[];
    // Досмотрели все, кто готовил: серия в их списке отмечена (время — последняя отметка)
    let watchedAt: number | null = null;
    if (r.anilist_id && r.ep && users.length) {
      const marks = users.map((u) => db.prepare<[number, number], { episodes: number; updated_at: number }>(
        "SELECT episodes, updated_at FROM list_entries WHERE user_id = ? AND anilist_id = ? AND deleted = 0").get(u, r.anilist_id!));
      if (marks.every((m) => m && m.episodes >= r.ep!)) watchedAt = Math.max(...marks.map((m) => m!.updated_at));
    }
    const used = r.anilist_id && r.ep ? db.prepare<[number, number], { at: number | null }>(
      "SELECT max(updated_at) at FROM playback_pos WHERE anilist_id = ? AND ep = ?").get(r.anilist_id, r.ep)?.at ?? null : null;
    return { key: r.key, size: r.size, doneAt: r.done_at, watchedAt, usedAt: used, createdAt: r.created_at };
  });
  const evict = new Set(toEvict(items, now(), prepPolicy()));
  // Серию убрали из «Стрима» (скачал Sonarr, раздачу сменили) — подготовленное больше не нужно
  for (const r of all) if (!strmEpisodes(r.hash).some((e) => e.index === r.idx)) evict.add(r.key);
  // Качается, а задачи нет (календарь перезапускался) — пусть докачивается: допишем, когда файл появится
  for (const r of all) {
    if (r.done_at === null && fs.existsSync(path.join(PREP_DIR(), r.rel))) {
      db.prepare("UPDATE prepared_files SET done_at = ? WHERE key = ?").run(now(), r.key);
      for (const u of JSON.parse(r.users) as number[]) {
        notify(u, { kind: "prebuffer", anilistId: r.anilist_id ?? undefined, title: `${r.ep ? `${r.ep} серия` : "Серия"} скачана — смотрите без остановок` });
      }
    }
  }
  for (const key of evict) await dropOne(key).catch((e) => console.warn(`[prep] ${key}: ${String(e)}`));
  writeIndex();
  // Миниатюры шкалы у оставшихся (скачанных до появления миниатюр или после сбоя)
  for (const r of all) {
    const file = !evict.has(r.key) && preparedPath(r.hash, r.idx);
    if (file) ensureThumbs(r.hash, r.idx, file);
  }
}

/** Сводка для «Загрузок»: сколько серий и места занято, лимит. */
export function prepSummary() {
  const all = rows();
  const p = prepPolicy();
  return { count: all.filter((r) => r.done_at).length, downloading: all.filter((r) => !r.done_at).length, used: all.reduce((s, r) => s + r.size, 0), limit: p.limitBytes };
}
