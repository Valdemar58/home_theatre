import { airedNow } from "./episode-notice";
import type { AnimeDetails } from "./types";

type Release = Pick<AnimeDetails, "status" | "episodes" | "nextAiringEpisode" | "schedule">;
export function titleWatchTarget(media: Release, watched: number, now: number) {
  const scheduled = media.schedule.filter(s => s.airingAt <= now).reduce((n, s) => Math.max(n, s.episode), 0);
  const aired = media.status === "FINISHED" && media.episodes ? media.episodes : airedNow(media, now) ?? (scheduled || null);
  const complete = !!media.episodes && watched >= media.episodes && media.status === "FINISHED";
  const next = complete ? 1 : watched + 1;
  return { aired, complete, target: aired !== null && next <= aired ? next : null };
}
