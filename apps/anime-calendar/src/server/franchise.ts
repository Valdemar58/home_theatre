import "server-only";
import { franchiseItems, franchiseProgress, franchiseRoot, FRANCHISE_LIMIT, nextUp, type EntryLite, type FranchiseNode } from "@/lib/franchise";
import type { FranchiseView, MediaLite } from "@/lib/types";
import { getDetails, type AnilistDetails } from "./anilist";
import { enqueue } from "./archive";
import { getCached } from "./cache";
import { db } from "./db";
import { withShikimori } from "./lists";
import { seasonArcs } from "./plot-graph";

// Страница франшизы (IDEAS #80): все сюжетно связанные тайтлы в порядке выхода, мой прогресс, что смотреть дальше,
// арки сюжета по сезонам на мой прогресс. Страницы тайтлов — из кэша AniList; недостающие догружает архив
// (франшиза вроде Gundam — сотни связей, ждать их здесь нельзя), страница переспрашивает, пока partial.

const STORY = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "SUMMARY"]);

/** Карточка без описания, тегов, расписания и связей — в ответе десятки тайтлов. */
function lite(m: MediaLite): MediaLite {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { coverXL, description, synonyms, trailer, tags, schedule, relations, ...rest } = m as MediaLite & Record<string, unknown>;
  return rest;
}

const node = (d: AnilistDetails): FranchiseNode => ({ media: d, rel: d.relations.map((r) => ({ type: r.relationType, id: r.media.id })) });

export async function franchiseOf(userId: number, id: number): Promise<FranchiseView> {
  const start = await getDetails(id);
  const nodes = new Map<number, FranchiseNode>([[id, node(start)]]);
  const missing: number[] = [];
  const queue: AnilistDetails[] = [start];
  while (queue.length && nodes.size < FRANCHISE_LIMIT * 2) {
    const d = queue.shift()!;
    for (const r of d.relations) {
      if (!STORY.has(r.relationType) || nodes.has(r.media.id)) continue;
      const full = getCached<AnilistDetails>(`media:v2:${r.media.id}`, true);
      nodes.set(r.media.id, full ? node(full) : { media: r.media, rel: null });
      if (full) queue.push(full);
      else missing.push(r.media.id);
    }
  }
  if (missing.length) enqueue(missing, "page", `open:${id}`, 1);

  const root = franchiseRoot(id, nodes);
  const items = franchiseItems(root, nodes);
  await withShikimori(items.map((i) => i.media));
  const entries = new Map(db.prepare<[number], EntryLite & { anilist_id: number }>(
    "SELECT anilist_id, status, episodes FROM list_entries WHERE user_id = ? AND deleted = 0").all(userId).map((e) => [e.anilist_id, e]));
  const next = nextUp(items, entries);
  // Состав — на тот сезон основной истории, где я сейчас: смотрю, следующий или последний досмотренный
  const main = items.filter((i) => i.kind === "main");
  const castTitle = main.find((i) => entries.get(i.media.id)?.status === "watching")?.media.id
    ?? next ?? main.filter((i) => entries.has(i.media.id)).at(-1)?.media.id ?? root;
  return {
    root, castTitle, next, partial: missing.length > 0, progress: franchiseProgress(items, entries),
    items: items.map((i) => {
      const e = entries.get(i.media.id);
      return { media: lite(i.media), kind: i.kind, entry: e ? { status: e.status, episodes: e.episodes } : null, plot: seasonArcs(userId, i.media.id) };
    }),
  };
}
