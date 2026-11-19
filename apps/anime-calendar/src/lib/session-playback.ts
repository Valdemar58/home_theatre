import type { SessionBlock } from "./session-plan";

/** Persisted execution snapshot. Revision rejects commands from a previous episode/countdown. */
export type SessionPlayback = {
  sessionId: number;
  blocks: SessionBlock[];
  block: number;
  episode: number;
  revision: number;
  phase: "watching" | "next" | "break" | "complete";
  deadline: number | null;
  autoplay: boolean;
  heartbeatAt?: number;
  blocked?: string;
};
export function sessionItem(p: SessionPlayback) {
  const b = p.blocks[p.block];
  return { anilistId: b.anilistId, ep: b.episodes[p.episode] };
}
export function nextSessionItem(p: SessionPlayback) {
  const b = p.blocks[p.block];
  if (p.episode + 1 < b.episodes.length) return { block: p.block, episode: p.episode + 1, anilistId: b.anilistId, ep: b.episodes[p.episode + 1] };
  const next = p.blocks[p.block + 1];
  return next ? { block: p.block + 1, episode: 0, anilistId: next.anilistId, ep: next.episodes[0] } : null;
}
export function finishSessionEpisode(p: SessionPlayback, at: number): SessionPlayback {
  if (p.phase !== "watching") return p;
  const next = nextSessionItem(p);
  if (!next) return { ...p, revision: p.revision + 1, phase: "complete", deadline: null };
  const between = next.block !== p.block;
  return { ...p, revision: p.revision + 1, phase: between ? "break" : "next", deadline: at + (between ? p.blocks[p.block].breakMinutes * 60_000 : 10_000), blocked: undefined };
}
export function advanceSession(p: SessionPlayback): SessionPlayback {
  const next = nextSessionItem(p);
  if (!next) return p;
  return { ...p, block: next.block, episode: next.episode, phase: "watching", revision: p.revision + 1, deadline: null, blocked: undefined };
}
