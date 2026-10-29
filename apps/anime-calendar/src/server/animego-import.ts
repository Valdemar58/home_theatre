import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { AgItem, AgReview, AgValues, ListStatus, MediaLite } from "@/lib/types";
import { mediaByIds } from "./anilist";
import { getCached } from "./cache";
import { now } from "./db";
import { env } from "./env";
import { getMedia, getRows, saveMedia, upsertEntry, withShikimori, type EntryPatch } from "./lists";
import type { User } from "./session";

// Разовый импорт списка AnimeGo: план готовит scripts/import_animego.py (AnimeGo открыт только из Польши),
// здесь — проверка и правка перед записью. Правки — отдельным файлом рядом с планом (план не трогаем):
// привязка к тайтлу, статус, оценка, «не переносить». Запись — по кнопке, через upsertEntry (дальше — Shikimori).

const DIR = () => path.join(env.dataDir, "import");

// Вкладки AnimeGo → статусы календаря
const TABS: Record<string, ListStatus> = {
  "смотрю": "watching", "просмотрено": "completed", "отложено": "on_hold", "брошено": "dropped",
  "запланировано": "planned", "пересматриваю": "rewatching",
};

type PlanRow = {
  id: number; slug: string; tab: string; title: string; original: string | null; score: number | null;
  anilistId: number | null; how: string;
};
type Edit = { anilistId?: number | null; status?: ListStatus; score?: number | null; skip?: boolean };
type Edits = Record<string, Edit>;

function planFile(): { user: number; file: string } | null {
  if (!fs.existsSync(DIR())) return null;
  const name = fs.readdirSync(DIR()).find((f) => /^animego-\d+-plan\.json$/.test(f));
  return name ? { user: Number(name.match(/\d+/)![0]), file: path.join(DIR(), name) } : null;
}
const editsFile = (user: number) => path.join(DIR(), `animego-${user}-review.json`);

function readEdits(user: number): Edits {
  const f = editsFile(user);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Edits) : {};
}

/** Карточка тайтла для показа: из списка, из хранилища или пачкой из AniList (лимит — 50 за запрос). */
async function mediaFor(ids: number[]): Promise<Map<number, MediaLite>> {
  const out = new Map<number, MediaLite>();
  const missing: number[] = [];
  for (const id of new Set(ids)) {
    const m = getMedia(id) ?? getCached<MediaLite>(`lite:${id}`, true);
    if (m) out.set(id, m);
    else missing.push(id);
  }
  if (missing.length) for (const m of await withShikimori(await mediaByIds(missing))) out.set(m.id, m);
  return out;
}

/** Что запишется по умолчанию: новый — статус и оценка AnimeGo; уже в списке — только оценка, если её нет. */
function defaults(ag: AgValues, local: AgValues | null): AgValues & { include: boolean } {
  if (!local) return { ...ag, include: Boolean(ag.status) };
  const score = local.score ?? ag.score;
  return { status: local.status, score, include: score !== local.score };
}

export async function review(user: User): Promise<AgReview> {
  const pf = planFile();
  if (!pf) return { profile: null, items: [], progress: progress.get(user.id) ?? null };
  const plan = JSON.parse(fs.readFileSync(pf.file, "utf8")) as PlanRow[];
  const edits = readEdits(pf.user);
  const local = new Map(getRows(user.id).map((r) => [r.anilist_id, r]));
  const bound = (r: PlanRow) => (String(r.id) in edits && edits[r.id].anilistId !== undefined ? edits[r.id].anilistId! : r.anilistId);
  const media = await mediaFor(plan.map(bound).filter((x): x is number => Boolean(x)));
  const uses = new Map<number, number>();
  for (const r of plan) { const id = bound(r); if (id) uses.set(id, (uses.get(id) ?? 0) + 1); }

  const items = plan.map((r): AgItem => {
    const e = edits[r.id] ?? {};
    const anilistId = bound(r);
    const row = anilistId ? local.get(anilistId) : undefined;
    const ag: AgValues = { status: TABS[r.tab.trim().toLowerCase()] ?? null, score: r.score };
    const mine: AgValues | null = row ? { status: row.status, score: row.score || null } : null;
    const d = defaults(ag, mine);
    const m = anilistId ? media.get(anilistId) : undefined;
    return {
      agId: r.id, url: `https://animego.me/anime/${r.slug}`, title: r.title, original: r.original, ag,
      how: e.anilistId !== undefined ? "manual" : !r.anilistId ? "none" : r.how.startsWith("уже") ? "list"
        : r.how.includes("проверь") ? "check" : "search",
      anilistId,
      media: m ? {
        id: m.id, title: m.title.ru || m.title.romaji || m.title.english || String(m.id), romaji: m.title.romaji,
        cover: m.coverImage.large, format: m.format, year: m.seasonYear ?? m.startDate.year, episodes: m.episodes,
      } : null,
      local: mine,
      status: e.status ?? d.status,
      score: e.score !== undefined ? e.score : d.score,
      include: Boolean(anilistId) && (e.skip !== undefined ? !e.skip : d.include),
      edited: Object.keys(e).length > 0,
      duplicate: anilistId ? (uses.get(anilistId) ?? 0) > 1 : false,
    };
  });
  return { profile: pf.user, items, progress: progress.get(user.id) ?? null };
}

/** Правка одной записи; null в поле — вернуть как было. */
export function saveEdit(agId: number, patch: Record<string, unknown>): void {
  const pf = planFile();
  if (!pf) throw new Error("Плана импорта нет — сначала запусти scripts/import_animego.py");
  const edits = readEdits(pf.user);
  const e: Edit = { ...edits[agId] };
  if ("reset" in patch) delete edits[agId];
  else {
    if ("anilistId" in patch) e.anilistId = patch.anilistId === null ? null : Number(patch.anilistId);
    if ("status" in patch) e.status = patch.status as ListStatus;
    if ("score" in patch) e.score = patch.score === null ? null : Number(patch.score);
    if ("skip" in patch) e.skip = Boolean(patch.skip);
    edits[agId] = e;
  }
  fs.writeFileSync(editsFile(pf.user), JSON.stringify(edits, null, 1));
}

// ---------------------------------------------------------------- запись

type Progress = { done: number; total: number; failed: string[]; startedAt: number; finishedAt?: number; error?: string };
const progress = new Map<number, Progress>();

export function startApply(user: User): Progress {
  const cur = progress.get(user.id);
  if (cur && !cur.finishedAt) return cur;
  const p: Progress = { done: 0, total: 0, failed: [], startedAt: now() };
  progress.set(user.id, p);
  void (async () => {
    const { items } = await review(user);
    const todo = items.filter((i) => i.include && i.anilistId && i.status);
    p.total = todo.length;
    const missing = [...new Set(todo.map((i) => i.anilistId!))].filter((id) => !getMedia(id));
    for (let i = 0; i < missing.length; i += 50) saveMedia(await withShikimori(await mediaByIds(missing.slice(i, i + 50))));
    for (const i of todo) {
      const media = getMedia(i.anilistId!);
      if (!media) { p.failed.push(i.title); p.done++; continue; }
      // Уже в списке — только то, что отличается; новый — статус и оценка
      const patch: EntryPatch = {};
      if (!i.local || i.status !== i.local.status) patch.status = i.status!;
      if (i.score && i.score !== i.local?.score) patch.score = i.score;
      if (Object.keys(patch).length) upsertEntry(user.id, media, patch);
      p.done++;
    }
  })()
    .catch((err) => { p.error = err instanceof Error ? err.message : String(err); })
    .finally(() => { p.finishedAt = now(); });
  return p;
}
