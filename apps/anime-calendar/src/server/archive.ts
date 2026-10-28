import "server-only";
import { DEFAULT_FILTERS } from "@/lib/filters";
import { freshFor } from "@/lib/freshness";
import type { MediaLite } from "@/lib/types";
import { anilistBusy, browse, getCalendar, getDetails, mediaByIds, type AnilistDetails } from "./anilist";
import { getCached, setCached } from "./cache";
import { db, now } from "./db";
import { externalIds } from "./idmap";
import { pinImage } from "./img-cache";
import { withShikimori } from "./lists";
import { mediaImages } from "./media-images";
import { episodesOf } from "./plot";
import { titleCharacters } from "./plot-graph";
import { ruDescription } from "./shikimori";
import { isOutage, sourceDown } from "./sources";
import { registerHandler } from "./tasks";

// Локальный архив тайтлов: данные о тайтлах набиваются в базу в фоне, чтобы страницы открывались без внешних API
// и работали без сети. Уровни: card — карточка (пачкой по 50), page — страница тайтла (AniList, русское название
// и описание Shikimori), full — всё (серии, персонажи, галерея, картинки закреплены). Поводы: открыли тайтл (он и
// связи до глубины 3, не больше 60), добавили в список (полностью), первичный прогон, кнопка на календаре.
// Работает только когда AniList свободен от запросов страниц и доступен; перепроверка — по живости тайтла.

export type ArchiveLevel = "card" | "page" | "full";
const RANK: Record<ArchiveLevel, number> = { card: 1, page: 2, full: 3 };
// Сюжетные связи: без «персонаж там же», «прочее» и первоисточника-манги
const STORY = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "SUMMARY"]);
const OPEN_BUDGET = 60;
const PRIORITY = { list: 80, open: 50, calendar: 40, initial: 30, recheck: 10 } as const;
type Reason = keyof typeof PRIORITY;

type Item = { anilist_id: number; level: ArchiveLevel; priority: number; reason: string; depth: number };

// Сколько тайтлов уже поставлено по одному открытию (франшизы вроде Gundam дают сотни связей)
const budget = new Map<string, number>();

const stateOf = (id: number) => db.prepare<[number], { level: ArchiveLevel; next_check: number }>("SELECT level, next_check FROM archive_state WHERE anilist_id = ?").get(id);

/** Поставить тайтлы в очередь (уже сохранённое на этом уровне и свежее — пропускается). */
export function enqueue(ids: number[], level: ArchiveLevel, reason: Reason | `open:${number}`, depth = 0): number {
  const kind = reason.split(":")[0] as Reason;
  const t = now();
  let added = 0;
  const up = db.prepare(`INSERT INTO archive_queue (anilist_id, level, priority, reason, depth, queued_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (anilist_id) DO UPDATE SET
      level = CASE WHEN excluded.level = 'full' OR archive_queue.level = 'full' THEN 'full'
                   WHEN excluded.level = 'page' OR archive_queue.level = 'page' THEN 'page' ELSE 'card' END,
      priority = MAX(archive_queue.priority, excluded.priority), depth = MIN(archive_queue.depth, excluded.depth)`);
  for (const id of new Set(ids)) {
    const st = stateOf(id);
    if (st && RANK[st.level] >= RANK[level] && st.next_check > t) continue;
    if (kind === "open") {
      const used = budget.get(reason) ?? 0;
      if (used >= OPEN_BUDGET) break;
      budget.set(reason, used + 1);
    }
    up.run(id, level, PRIORITY[kind], reason, depth, t);
    added++;
  }
  return added;
}

/** Открыли тайтл: он сам и сюжетные связи (1–2 — страница, 3 — карточка), не больше 60 на открытие. */
export function archiveOpened(d: AnilistDetails) {
  const reason = `open:${d.id}` as const;
  budget.delete(reason);
  budget.set(reason, 1);
  markSaved(d.id, "page", d);
  enqueue(d.relations.filter((r) => STORY.has(r.relationType)).map((r) => r.media.id), "page", reason, 1);
}

/** Тайтлы списков — полностью (любой путь добавления: PUT, AniLib, Shikimori, Jellyfin). */
export function archiveLists(): number {
  const ids = db.prepare<[], { anilist_id: number }>("SELECT DISTINCT anilist_id FROM list_entries WHERE deleted = 0").all().map((r) => r.anilist_id);
  return enqueue(ids, "full", "list");
}

function markSaved(id: number, level: ArchiveLevel, m: Pick<MediaLite, "status" | "endDate"> & { finaleAt?: number | null }) {
  const prev = stateOf(id);
  const lvl = prev && RANK[prev.level] > RANK[level] ? prev.level : level;
  db.prepare(`INSERT INTO archive_state (anilist_id, level, saved_at, next_check) VALUES (?, ?, ?, ?)
    ON CONFLICT (anilist_id) DO UPDATE SET level = excluded.level, saved_at = excluded.saved_at, next_check = excluded.next_check`)
    .run(id, lvl, now(), now() + freshFor(m));
}

// ---------------------------------------------------------------- исполнитель

async function savePage(id: number): Promise<AnilistDetails> {
  const d = await getDetails(id, { wait: true });
  await withShikimori([{ ...d }]);
  if (d.idMal) await ruDescription(d.idMal).catch((e) => { if (isOutage(e)) throw e; });
  return d;
}

async function saveFull(id: number): Promise<AnilistDetails> {
  const d = await savePage(id);
  await episodesOf(d);
  await titleCharacters(d.id, d.idMal).catch((e) => { if (isOutage(e)) throw e; });
  const ids = await externalIds(d.id);
  const gallery = await mediaImages(d, ids);
  // Картинки — навсегда: обложка, баннер, фон, первые кадры
  const urls = [d.coverXL ?? d.coverImage.large, d.bannerImage, gallery.backdrop, ...gallery.images.slice(0, 6).map((g) => g.url)].filter((u): u is string => Boolean(u));
  for (const u of new Set(urls)) await pinImage(u).catch(() => undefined);
  return d;
}

async function process(item: Item) {
  const d = item.level === "full" ? await saveFull(item.anilist_id) : await savePage(item.anilist_id);
  markSaved(d.id, item.level, d);
  // Связи: по открытию — до глубины 3 (последняя — карточкой), по спискам — прямые связи страницей
  const story = d.relations.filter((r) => STORY.has(r.relationType)).map((r) => r.media.id);
  if (item.reason.startsWith("open:") && item.depth < 3) {
    enqueue(story, item.depth + 1 >= 3 ? "card" : "page", item.reason as `open:${number}`, item.depth + 1);
  } else if ((item.reason === "list" || item.reason === "initial") && item.depth === 0) {
    enqueue(story, "page", item.reason, 1);
  }
}

/** Карточки — пачкой: одна страница AniList на 50 тайтлов. */
async function processCards(items: Item[]) {
  const got = await withShikimori(await mediaByIds(items.map((i) => i.anilist_id)));
  for (const m of got) markSaved(m.id, "card", m);
}

let busy = false;
const del = (id: number) => db.prepare("DELETE FROM archive_queue WHERE anilist_id = ?").run(id);

/** Шаг исполнителя (из jobs.ts): несколько тайтлов, пока AniList свободен от запросов страниц. */
export async function archiveTick(maxItems = 6): Promise<number> {
  if (busy || sourceDown("anilist")) return 0;
  busy = true;
  let done = 0;
  try {
    while (done < maxItems && !anilistBusy() && !sourceDown("anilist")) {
      const cards = db.prepare<[], Item>("SELECT * FROM archive_queue WHERE level = 'card' ORDER BY priority DESC, queued_at LIMIT 50").all();
      const top = db.prepare<[], Item>("SELECT * FROM archive_queue ORDER BY priority DESC, queued_at LIMIT 1").get();
      if (!top) break;
      try {
        if (top.level === "card") {
          await processCards(cards);
          cards.forEach((c) => del(c.anilist_id));
          done += cards.length;
        } else {
          await process(top);
          del(top.anilist_id);
          done++;
        }
      } catch (e) {
        // Источник лёг — остаётся в очереди до его возвращения; иное (тайтла нет) — убрать
        if (isOutage(e)) break;
        console.warn(`[archive] ${top.anilist_id}: ${String(e)}`);
        del(top.anilist_id);
      }
    }
  } finally {
    busy = false;
  }
  return done;
}

/** Плановая перепроверка: сохранённое, у которого подошёл срок (вышедшее давно — раз в 90 дней). */
export function archiveRecheck(limit = 200): number {
  const due = db.prepare<[number, number], { anilist_id: number; level: ArchiveLevel }>(
    "SELECT anilist_id, level FROM archive_state WHERE next_check < ? AND level != 'card' ORDER BY next_check LIMIT ?").all(now(), limit);
  let n = 0;
  for (const lvl of ["page", "full"] as const) n += enqueue(due.filter((r) => r.level === lvl).map((r) => r.anilist_id), lvl, "recheck");
  return n;
}

const SEASONS = ["WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER"];

/** Первичный прогон (один раз): списки полностью, их связи страницей, текущий сезон страницей. */
export async function archiveInitial(): Promise<void> {
  if (getCached<boolean>(INITIAL_KEY, true)) return;
  archiveLists();
  const d = new Date();
  const season = SEASONS[d.getUTCMonth()];
  const year = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  for (let page = 1; page <= 5; page++) {
    const r = await browse({ page, season, year, filters: DEFAULT_FILTERS });
    enqueue(r.media.map((m) => m.id), "page", "initial");
    if (!r.hasNextPage) break;
  }
  setCached(INITIAL_KEY, true, 10 * 365 * 86400, "entity");
}

const INITIAL_KEY = "archive:initial-done";

/** Состояние архива — для настроек и проверки. */
export function archiveStats() {
  const levels = Object.fromEntries(db.prepare<[], { level: string; n: number }>("SELECT level, COUNT(*) n FROM archive_state GROUP BY level").all().map((r) => [r.level, r.n]));
  const queued = db.prepare<[], { n: number }>("SELECT COUNT(*) n FROM archive_queue").get()!.n;
  return { levels, queued };
}

// Кнопка «Сохранить» на календаре: тайтлы показанного периода — страницей; ключ задачи — «from-to» (секунды)
registerHandler("archive", {
  noun: "Период сохранён",
  title: async (key) => {
    const [from, to] = key.split("-").map(Number);
    const f = (t: number) => new Date(t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    return `Календарь ${f(from)} – ${f(to)}`;
  },
  fresh: () => false,
  href: () => "/",
  run: async (key, signal) => {
    const [from, to] = key.split("-").map(Number);
    const cal = await getCalendar(from, to);
    const ids = Object.keys(cal.media).map(Number);
    let saved = 0;
    for (const id of ids) {
      signal.throwIfAborted();
      const st = stateOf(id);
      if (st && RANK[st.level] >= RANK.page && st.next_check > now()) { saved++; continue; }
      try {
        markSaved(id, "page", await savePage(id));
        saved++;
      } catch (e) {
        if (isOutage(e)) throw e;
      }
    }
    return { summary: `Сохранено тайтлов: ${saved} из ${ids.length}`, isNew: saved > 0 };
  },
});
