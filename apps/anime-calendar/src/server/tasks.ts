import "server-only";
import type { TaskInfo } from "@/lib/types";
import { getDetails } from "./anilist";
import { getCached, setCached } from "./cache";
import { db, now } from "./db";
import { env } from "./env";
import { getMedia } from "./lists";
import { notify } from "./notifications";
import { ruReleases, type RuReleasesResponse } from "./ru/releases";
import { shikiInfo } from "./shikimori";

// Фоновые задачи вместо «сиди и жди колёсико»: запрос уходит в очередь, окно можно закрыть,
// по готовности — уведомление (колокольчик + тост). Одна задача на (вид, ключ): повторный запуск
// присоединяется к идущей. Очередь своя у каждого вида и последовательная (RuTracker через FlareSolverr
// не любит параллель; долгая подготовка серии не держит поиск озвучек), ручные запуски — вперёд автоматических.
//
// Происхождение:
//  • user — нажали кнопку: результат ждут, уведомляем;
//  • auto — открыли страницу тайтла: прогрев кэша; закрыли вкладку, так и не нажав, — задача отменяется;
//  • schedule — плановое обновление (онгоинги из «Смотрю»): уведомляем, только если появилось новое.

export type TaskOrigin = TaskInfo["origin"];
type Waiter = { u: number; notify: boolean };
type Row = {
  id: number; kind: string; key: string; title: string; status: TaskInfo["status"]; origin: TaskOrigin;
  waiters: string; error: string | null; created_at: number; started_at: number | null; finished_at: number | null;
};

export type TaskContext = {
  /** Уведомить ждущих посреди работы (например, «серию уже можно смотреть»), не дожидаясь конца */
  notify: (body: string) => void;
  /** Кто запустил (на момент старта) и кто ждёт — например, чтобы продолжить цепочку задач для них же */
  origin: TaskOrigin;
  userIds: number[];
};

export type Handler = {
  title: (key: string) => Promise<string>;
  /** Свежий результат уже есть — автоматический запуск не нужен */
  fresh: (key: string) => boolean;
  run: (key: string, signal: AbortSignal, ctx: TaskContext) => Promise<{ summary: string; isNew: boolean; silent?: boolean }>;
  href: (key: string) => string;
  noun: string;
  /** Тайтл задачи — для обложки в уведомлении */
  anilistId?: (key: string) => Promise<number | null>;
};

// ---------------------------------------------------------------- озвучки

const VOICES_FRESH = 6 * 3600;
const voicesKey = (id: string) => `ru-voices:${id}`;
export type CachedVoices = { at: number; data: RuReleasesResponse };

/** Озвучки из кэша фоновой задачи (любой давности: устаревшие показываем, пока идёт обновление). */
export const cachedVoices = (id: number) => getCached<CachedVoices>(voicesKey(String(id)), true);

const pluralRu = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};

// Для сводки — только похожее на студии: без служебных пометок («ext») и описаний состава («трехголосая муж, жен»)
const studios = (d: RuReleasesResponse) => [...new Set(d.releases.flatMap((r) => r.voices))]
  .filter((v) => v.length > 3 && !/голос|муж|жен/i.test(v)).slice(0, 4).join(", ");

/** Другие модули добавляют свои виды задач (подготовка серии — prebuffer.ts). */
export function registerHandler(kind: string, h: Handler) {
  HANDLERS[kind] = h;
}

// Состояние очереди — одно на процесс: Next.js собирает маршруты отдельными пакетами, и у каждого может быть
// своя копия этого модуля. С копией на модуль новый маршрут «восстанавливался» и отменял чужие идущие задачи
const g = globalThis as unknown as {
  __tasks?: { handlers: Record<string, Handler>; queues: Map<string, number[]>; controllers: Map<number, AbortController>; running: Set<string>; recovered: boolean };
};
const state = (g.__tasks ??= { handlers: {}, queues: new Map(), controllers: new Map(), running: new Set(), recovered: false });

const HANDLERS: Record<string, Handler> = Object.assign(state.handlers, {
  voices: {
    noun: "Озвучки",
    anilistId: async (key) => Number(key) || null,
    title: async (key) => {
      const d = await getDetails(Number(key));
      const ru = d.idMal ? (await shikiInfo([d.idMal])).get(d.idMal)?.russian : null;
      return ru ?? d.title.romaji ?? d.title.english ?? `#${key}`;
    },
    // Результат без оригинальных раздач (до IDEAS #88) — устаревший: искать заново
    fresh: (key) => {
      const c = getCached<CachedVoices>(voicesKey(key), true);
      return Boolean(c?.data.orig) && (c?.at ?? 0) > now() - VOICES_FRESH;
    },
    run: async (key, signal) => {
      const prev = getCached<CachedVoices>(voicesKey(key), true);
      const data = await ruReleases(Number(key), { signal, budgetMs: 90_000 });
      setCached(voicesKey(key), { at: now(), data } satisfies CachedVoices, 30 * 86400);
      const old = new Set(prev?.data.releases.map((r) => r.guid) ?? []);
      const added = prev ? data.releases.filter((r) => !old.has(r.guid)) : [];
      const n = data.releases.length;
      const summary = added.length
        ? `+${added.length} ${pluralRu(added.length, "новая раздача", "новые раздачи", "новых раздач")}${studios({ ...data, releases: added }) ? `: ${studios({ ...data, releases: added })}` : ""}`
        : n ? `${n} ${pluralRu(n, "раздача", "раздачи", "раздач")}${studios(data) ? ` — ${studios(data)}` : ""}` : "Раздач с русской озвучкой не нашлось";
      return { summary, isNew: added.length > 0 };
    },
    href: (key) => `/anime/${key}?voices=1`,
  },
} satisfies Record<string, Handler>);

// ---------------------------------------------------------------- очередь

const { queues, controllers, running } = state;
const queueOf = (kind: string): number[] => queues.get(kind) ?? (queues.set(kind, []), queues.get(kind)!);

const getRow = (id: number) => db.prepare<[number], Row>("SELECT * FROM tasks WHERE id = ?").get(id);
const activeRow = (kind: string, key: string) => db.prepare<[string, string], Row>(
  "SELECT * FROM tasks WHERE kind = ? AND key = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1").get(kind, key);
const setWaiters = (id: number, w: Waiter[]) => db.prepare("UPDATE tasks SET waiters = ? WHERE id = ?").run(JSON.stringify(w), id);
const waitersOf = (r: Row) => JSON.parse(r.waiters) as Waiter[];

const info = (r: Row): TaskInfo => ({
  id: r.id, kind: r.kind, key: r.key, status: r.status, origin: r.origin, error: r.error,
  createdAt: r.created_at, finishedAt: r.finished_at,
});

/** Задачи прошлого запуска процесса не доделаются — отмечаем прерванными. */
function recover() {
  if (state.recovered) return;
  state.recovered = true;
  db.prepare("UPDATE tasks SET status = 'cancelled', error = 'прервано перезапуском', finished_at = ? WHERE status IN ('queued', 'running')").run(now());
  // История — неделя
  db.prepare("DELETE FROM tasks WHERE created_at < ?").run(now() - 7 * 86400);
}

/**
 * Запустить задачу или присоединиться к идущей. auto/schedule со свежим результатом — ничего не делает (null).
 */
export async function startTask(kind: string, key: string, opts: { userId?: number; origin: TaskOrigin; notify?: boolean }): Promise<TaskInfo | null> {
  recover();
  const h = HANDLERS[kind];
  if (!h) throw new Error(`неизвестная задача: ${kind}`);
  const me: Waiter[] = opts.userId ? [{ u: opts.userId, notify: opts.notify ?? opts.origin === "user" }] : [];
  const active = activeRow(kind, key);
  if (active) {
    const w = waitersOf(active);
    for (const m of me) {
      const same = w.find((x) => x.u === m.u);
      if (same) same.notify ||= m.notify;
      else w.push(m);
    }
    setWaiters(active.id, w);
    if (opts.origin === "user" && active.origin !== "user") {
      db.prepare("UPDATE tasks SET origin = 'user' WHERE id = ?").run(active.id);
      // Нажали кнопку — вперёд очереди
      const queue = queueOf(kind);
      const i = queue.indexOf(active.id);
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    }
    return info(getRow(active.id)!);
  }
  if (opts.origin !== "user" && h.fresh(key)) return null;
  const title = await h.title(key).catch(() => `#${key}`);
  const id = Number(db.prepare(
    "INSERT INTO tasks (kind, key, title, status, origin, waiters, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
    .run(kind, key, title, opts.origin, JSON.stringify(me), now()).lastInsertRowid);
  const queue = queueOf(kind);
  if (opts.origin === "user") {
    // после уже идущих ручных, но перед автоматическими
    const firstAuto = queue.findIndex((q) => getRow(q)?.origin !== "user");
    queue.splice(firstAuto < 0 ? queue.length : firstAuto, 0, id);
  } else {
    queue.push(id);
  }
  void drain(kind);
  return info(getRow(id)!);
}

/**
 * Отмена автоматической задачи, когда пользователь ушёл со страницы, так и не нажав кнопку.
 * Задачу, которую кто-то ждёт (нажал кнопку), не трогаем.
 */
export function cancelAuto(kind: string, key: string, userId: number) {
  const active = activeRow(kind, key);
  if (!active || active.origin === "user") return;
  const rest = waitersOf(active).filter((w) => w.u !== userId);
  setWaiters(active.id, rest);
  if (rest.length || active.origin === "schedule") return;
  stop(active);
}

function stop(active: Row) {
  if (active.status === "queued") {
    const queue = queueOf(active.kind);
    const i = queue.indexOf(active.id);
    if (i >= 0) queue.splice(i, 1);
    db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), active.id);
  } else {
    controllers.get(active.id)?.abort();
  }
}

/** Отменить задачу по кнопке (подготовка серии и т. п.) — независимо от того, кто её ждёт. */
export function cancelTask(kind: string, key: string) {
  const active = activeRow(kind, key);
  if (active) stop(active);
}

/** Идущие и ждущие задачи вида (для страницы «Загрузки»). */
export function activeTasks(kind: string): TaskInfo[] {
  return db.prepare<[string], Row>("SELECT * FROM tasks WHERE kind = ? AND status IN ('queued', 'running')").all(kind).map(info);
}

/** Последняя задача по ключу (для кнопки: идёт ли поиск). */
export function latestTask(kind: string, key: string): TaskInfo | null {
  recover();
  const r = db.prepare<[string, string], Row>("SELECT * FROM tasks WHERE kind = ? AND key = ? ORDER BY id DESC LIMIT 1").get(kind, key);
  return r ? info(r) : null;
}

async function drain(kind: string) {
  if (running.has(kind)) return;
  running.add(kind);
  const queue = queueOf(kind);
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const row = getRow(id);
      if (!row || row.status !== "queued") continue;
      await runOne(row);
    }
  } finally {
    running.delete(kind);
  }
}

async function runOne(row: Row) {
  const h = HANDLERS[row.kind];
  const ctl = new AbortController();
  controllers.set(row.id, ctl);
  db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(now(), row.id);
  try {
    const anilistId = await h.anilistId?.(row.key).catch(() => null) ?? null;
    // Тайтл есть — его название и обложку покажет карточка; нет — подпись задачи
    const about = { kind: row.kind, anilistId, subject: anilistId ? null : row.title, href: h.href(row.key) };
    const ctx: TaskContext = {
      notify: (body) => {
        for (const w of waitersOf(getRow(row.id)!)) {
          if (w.notify) notify(w.u, { ...about, title: body });
        }
      },
      origin: getRow(row.id)!.origin,
      userIds: waitersOf(getRow(row.id)!).map((w) => w.u),
    };
    const res = await h.run(row.key, ctl.signal, ctx);
    db.prepare("UPDATE tasks SET status = 'done', finished_at = ? WHERE id = ?").run(now(), row.id);
    const fresh = getRow(row.id)!;
    for (const w of waitersOf(fresh)) {
      if (res.silent) break;
      // Плановое обновление — только когда появилось новое
      if (fresh.origin === "schedule" ? res.isNew : w.notify) {
        notify(w.u, { ...about, title: res.summary });
      }
    }
  } catch (err) {
    const aborted = ctl.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(aborted ? "cancelled" : "error", aborted ? "отменено" : message, now(), row.id);
    if (!aborted) {
      // Трассировка — чтобы найти место ошибки без повторного запуска
      console.warn(`[tasks] ${row.kind} ${row.key}: ${message}`, err instanceof Error ? err.stack?.split("\n").slice(1, 6).join(" | ") : "");
      const anilistId = await h.anilistId?.(row.key).catch(() => null) ?? null;
      for (const w of waitersOf(getRow(row.id)!)) {
        if (w.notify) notify(w.u, { kind: row.kind, anilistId, subject: anilistId ? null : row.title, title: `${h.noun} — не получилось`, body: message, href: h.href(row.key), error: true });
      }
    }
  } finally {
    controllers.delete(row.id);
  }
}

// ---------------------------------------------------------------- плановое обновление

/**
 * Онгоинги из «Смотрю» и «Жду выхода»: раз в сутки обновить озвучки (не больше 5 тайтлов за проход),
 * чтобы кнопка открывалась мгновенно, а о новых раздачах приходило уведомление.
 */
export async function scheduleVoices(limit = 5) {
  if (!env.sonarrApiKey || !env.prowlarrApiKey) return;
  recover();
  const rows = db.prepare<[], { anilist_id: number; user_id: number }>(
    "SELECT anilist_id, user_id FROM list_entries WHERE status IN ('watching', 'rewatching', 'planned')").all();
  const byTitle = new Map<number, number[]>();
  for (const r of rows) byTitle.set(r.anilist_id, [...(byTitle.get(r.anilist_id) ?? []), r.user_id]);
  let started = 0;
  for (const [id, users] of byTitle) {
    if (started >= limit) break;
    const m = getMedia(id);
    if (!m || m.status !== "RELEASING" || m.format === "MOVIE") continue;
    if ((cachedVoices(id)?.at ?? 0) > now() - 86400) continue;
    const t = await startTask("voices", String(id), { origin: "schedule" });
    if (!t) continue;
    setWaiters(t.id, users.map((u) => ({ u, notify: true })));
    started++;
  }
}
