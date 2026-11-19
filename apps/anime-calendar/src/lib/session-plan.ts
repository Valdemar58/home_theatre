import type { MediaLite } from "./types";

export type SessionBlock = { anilistId: number; episodes: number[]; breakMinutes: number; durationMinutes: number; durationSource: "catalog" | "estimate" };
export type SessionDraft = { blocks: SessionBlock[]; skipCredits: boolean; timeZone: string };
export function legacyBlocks(s: { anilistId: number; ep: number; count: number }): SessionBlock[] {
  return [{ anilistId: s.anilistId, episodes: Array.from({ length: s.count }, (_, i) => s.ep + i), breakMinutes: 0, durationMinutes: 24, durationSource: "estimate" }];
}
/** No weekly extrapolation: only the provider's explicitly announced next release. */
export function episodeAvailability(m: MediaLite, ep: number, startsAt: number): { selectable: boolean; releaseAt?: number } {
  if (!Number.isInteger(ep) || ep < 1 || (m.episodes && ep > m.episodes)) return { selectable: false };
  if (m.status === "FINISHED") return { selectable: true };
  const next = m.nextAiringEpisode;
  if (next && ep < next.episode) return { selectable: true };
  if (next && ep === next.episode) return { selectable: next.airingAt <= startsAt, releaseAt: next.airingAt };
  return { selectable: false };
}
export function episodeCount(m: MediaLite): number { return m.episodes ?? m.nextAiringEpisode?.episode ?? 0; }
export function makeBlock(m: MediaLite, startsAt: number): SessionBlock {
  return { anilistId: m.id, episodes: Array.from({ length: episodeCount(m) }, (_, i) => i + 1).filter(ep => episodeAvailability(m, ep, startsAt).selectable), breakMinutes: 10, durationMinutes: m.duration && m.duration > 0 ? m.duration : 24, durationSource: m.duration && m.duration > 0 ? "catalog" : "estimate" };
}
export function sessionTimeline(blocks: SessionBlock[], startsAt: number, skipCredits: boolean) {
  let cursor = startsAt;
  return blocks.map((block, i) => {
    // A three-minute estimate must never erase a short episode.
    const deduction = skipCredits && block.durationMinutes > 3 ? 3 : 0;
    const start = cursor;
    const end = start + block.episodes.length * (block.durationMinutes - deduction) * 60;
    cursor = end + (i < blocks.length - 1 ? block.breakMinutes * 60 : 0);
    return { start, end, next: cursor, deduction };
  });
}
export function episodeLabel(episodes: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < episodes.length; i++) {
    const start = episodes[i]; let end = start;
    while (episodes[i + 1] === end + 1) end = episodes[++i];
    ranges.push(start === end ? String(start) : `${start}–${end}`);
  }
  return ranges.join(", ");
}
export function localDateTime(timestamp: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp * 1000));
  const v = (k: string) => p.find(x => x.type === k)?.value;
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}`;
}
/** Enumerate valid offsets: reject a DST gap and let the user choose a fold occurrence. */
export function localTimeCandidates(value: string, timeZone: string): number[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return [];
  const naive = Date.parse(value + "Z") / 1000;
  if (!Number.isFinite(naive)) return [];
  try {
    const offsets = new Set<number>();
    for (const delta of [-86400, 0, 86400]) {
      const t = naive + delta;
      offsets.add(Date.parse(localDateTime(t, timeZone) + "Z") / 1000 - t);
    }
    return [...offsets].map(o => naive - o).filter(t => localDateTime(t, timeZone) === value).sort((a, b) => a - b);
  } catch { return []; }
}
