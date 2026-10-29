import type { FuzzyDate, ListStatus, MediaLite } from "./types";

// Франшиза (IDEAS #80): все тайтлы, связанные сюжетом, — от корня (первый сезон), каждый со своим видом
// (основная история, дополнение, спин-офф, пересказ, альтернатива) и в порядке выхода, как смотреть.

export type FranchiseKind = "main" | "side" | "spinoff" | "recap" | "alt";

export const KIND_LABELS: Record<FranchiseKind, string> = {
  main: "Основная история", side: "Дополнение", spinoff: "Спин-офф", recap: "Пересказ", alt: "Альтернатива",
};

/** Тайтл и его сюжетные связи (null — страница тайтла ещё не загружена: связи неизвестны, дальше не идём). */
export type FranchiseNode = { media: MediaLite; rel: { type: string; id: number }[] | null };

export type FranchiseItem = { media: MediaLite; kind: FranchiseKind };

// Сюжетные связи: без «персонаж там же», «прочее» и первоисточника-манги (как в архиве)
const STORY = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "SUMMARY"]);
const CHAIN = new Set(["PREQUEL", "SEQUEL"]);
export const FRANCHISE_LIMIT = 80;

const startKey = (d: FuzzyDate) => (d.year ? d.year * 10000 + (d.month ?? 12) * 100 + (d.day ?? 31) : Infinity);
const isSeries = (m: MediaLite) => m.format === "TV" || m.format === "TV_SHORT" || m.format === "ONA";

/**
 * Корень франшизы: вверх по «предыстории» (сериалы — первыми, потом более ранние), без предыстории — к «основной
 * истории» (PARENT). Узел, связи которого неизвестны, — корень, пока не загрузится.
 */
export function franchiseRoot(start: number, nodes: Map<number, FranchiseNode>): number {
  const seen = new Set([start]);
  let cur = start;
  for (;;) {
    const rel = nodes.get(cur)?.rel ?? [];
    const up = (type: string) => rel.filter((r) => r.type === type && !seen.has(r.id) && nodes.has(r.id))
      .sort((a, b) => Number(isSeries(nodes.get(b.id)!.media)) - Number(isSeries(nodes.get(a.id)!.media))
        || startKey(nodes.get(a.id)!.media.startDate) - startKey(nodes.get(b.id)!.media.startDate))[0];
    const next = up("PREQUEL") ?? up("PARENT");
    if (!next) return cur;
    seen.add(next.id);
    cur = next.id;
  }
}

/** Вид связанного тайтла по связи от уже известного. Продолжение дополнения — тоже дополнение. */
function kindOf(from: FranchiseKind, type: string): FranchiseKind {
  if (type === "SPIN_OFF") return "spinoff";
  if (type === "ALTERNATIVE") return "alt";
  if (type === "SUMMARY") return "recap";
  if (type === "SIDE_STORY") return from === "main" ? "side" : from;
  // PARENT, PREQUEL, SEQUEL — вид того, откуда пришли (основную цепочку собирает первый проход)
  return from;
}

/**
 * Все тайтлы франшизы с видом, в порядке выхода (без даты — в конце; при равенстве — основная история первой).
 * Сначала основная цепочка — от корня только по «предыстория/продолжение», потом остальное обходом в ширину.
 */
export function franchiseItems(root: number, nodes: Map<number, FranchiseNode>): FranchiseItem[] {
  const kind = new Map<number, FranchiseKind>();
  const walk = (seeds: number[], only: Set<string> | null) => {
    const queue = [...seeds];
    while (queue.length && kind.size < FRANCHISE_LIMIT) {
      const id = queue.shift()!;
      for (const r of nodes.get(id)?.rel ?? []) {
        if (!STORY.has(r.type) || (only && !only.has(r.type)) || kind.has(r.id)) continue;
        const n = nodes.get(r.id);
        if (!n || n.media.format === "MUSIC") continue;
        kind.set(r.id, kindOf(kind.get(id)!, r.type));
        queue.push(r.id);
      }
    }
  };
  if (!nodes.has(root)) return [];
  kind.set(root, "main");
  walk([root], CHAIN);
  walk([...kind.keys()], null);
  const order: Record<FranchiseKind, number> = { main: 0, side: 1, recap: 2, spinoff: 3, alt: 4 };
  return [...kind].map(([id, k]) => ({ media: nodes.get(id)!.media, kind: k }))
    .sort((a, b) => startKey(a.media.startDate) - startKey(b.media.startDate) || order[a.kind] - order[b.kind] || a.media.id - b.media.id);
}

export type EntryLite = { status: ListStatus; episodes: number };

/** Что смотреть дальше: первый по порядку вышедший тайтл основной истории или дополнение, который я не досмотрел. */
export function nextUp(items: FranchiseItem[], entries: Map<number, EntryLite>): number | null {
  for (const it of items) {
    if (it.kind !== "main" && it.kind !== "side") continue;
    if (it.media.status === "NOT_YET_RELEASED") continue;
    const e = entries.get(it.media.id);
    if (e?.status === "completed" || e?.status === "dropped") continue;
    return it.media.id;
  }
  return null;
}

/** Серий всего и просмотрено (основная история и дополнения): незавершённые онгоинги — по вышедшим. */
export function franchiseProgress(items: FranchiseItem[], entries: Map<number, EntryLite>): { watched: number; total: number } {
  let watched = 0;
  let total = 0;
  for (const it of items) {
    if (it.kind !== "main" && it.kind !== "side") continue;
    const m = it.media;
    const eps = m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
    const e = entries.get(m.id);
    total += eps;
    watched += e?.status === "completed" ? eps : Math.min(e?.episodes ?? 0, eps || Infinity);
  }
  return { watched, total };
}
