import { rpgStats, type RpgStats } from "@/lib/profile-rpg";
import type { AchievementProgress } from "@/lib/achievements";
import { achievementsOf, achievementValues } from "@/server/achievements";
import { db, now } from "@/server/db";
import { publicList, visibleTo } from "@/server/social";
import { ApiError, authed, intParam, json } from "@/server/route";

type Titled = { id: number; title: string };

export type ProfileStatsResponse = {
  stats: RpgStats;
  achievements: AchievementProgress[];
  /** Портрет вкуса от LLM (из «Для тебя»), если уже построен */
  portrait: { text: string; likes: string[]; dislikes: string[] } | null;
  /** Баннер шапки: выбранный тайтл или по умолчанию — высшая оценка, при равенстве — оценённый позже */
  banner: (Titled & { image: string; chosen: boolean }) | null;
  /** Варианты баннера (только себе): тайтлы из списка, у которых есть баннер */
  bannerOptions: (Titled & { image: string; score: number })[];
  /** Витрина наград: выбранные (до 6) или самые прокачанные */
  showcase: { ids: string[]; chosen: boolean };
  /** «Зал славы»: выбранные тайтлы (до 10) или лучшие по оценке */
  hall: { items: (Titled & { cover: string | null; color: string | null; score: number })[]; chosen: boolean };
  /** Варианты для «Зала славы» (только себе): все тайтлы списка */
  hallOptions: (Titled & { cover: string | null; color: string | null; score: number })[];
  /** Все оценки — для «Зала славы» и разбора по баллам */
  ratings: (Titled & { cover: string | null; color: string | null; score: number; updatedAt: number })[];
  /** Часы просмотра по неделям (журнал реального просмотра, 26 недель); null — журнала ещё нет */
  weekly: { week: number; hours: number; episodes: number }[] | null;
};

const WEEK = 7 * 86400;
const SHOWCASE = 6;

// Богатая статистика профиля (RPG-характеристика) — только если профиль виден
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  const ownerId = intParam(id, "id");
  const owner = visibleTo(user.id, ownerId);
  if (!owner) throw new ApiError(403, "Профиль скрыт");
  const self = ownerId === user.id;
  const list = publicList(ownerId, user.id);
  const v = achievementValues(ownerId);
  const achievements = achievementsOf(ownerId, { notify: self });
  const stats = rpgStats(list, { friends: v.get("friends") ?? 0, comments: v.get("critic") ?? 0, together: v.get("together") ?? 0 }, now(), achievements);

  const prefs = db.prepare<[number], { profile_banner: number | null; showcase: string | null; hall: string | null; portrait: string | null }>(
    `SELECT u.profile_banner, u.showcase, u.hall, t.portrait FROM users u LEFT JOIN user_taste t ON t.user_id = u.id WHERE u.id = ?`).get(ownerId);
  const p = prefs?.portrait ? (JSON.parse(prefs.portrait) as { portrait_ru?: string; likes?: string[]; dislikes?: string[] }) : null;

  const title = (e: (typeof list)[number]) => e.media?.title.ru ?? e.media?.title.romaji ?? e.media?.title.english ?? `#${e.anilistId}`;
  const ratings = list.filter((e) => e.score > 0 && e.media)
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .map((e) => ({ id: e.anilistId, title: title(e), cover: e.media!.coverImage.large, color: e.media!.coverImage.color, score: e.score, updatedAt: e.updatedAt }));
  const withBanner = list.filter((e) => e.media?.bannerImage)
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  const chosen = prefs?.profile_banner ? withBanner.find((e) => e.anilistId === prefs.profile_banner) : undefined;
  const b = chosen ?? withBanner[0];

  const earned = achievements.filter((a) => a.tier > 0);
  const picked = (prefs?.showcase ?? "").split(",").filter((x) => earned.some((a) => a.id === x));
  const showcase = picked.length
    ? { ids: picked.slice(0, SHOWCASE), chosen: true }
    : { ids: [...earned].sort((a, z) => z.tier - a.tier || z.value - a.value).slice(0, SHOWCASE).map((a) => a.id), chosen: false };

  const inList = new Set(list.map((e) => e.anilistId));
  const hallPicked = (prefs?.hall ?? "").split(",").map(Number).filter((x) => inList.has(x));
  const card = (id: number) => {
    const e = list.find((x) => x.anilistId === id)!;
    return { id, title: title(e), cover: e.media?.coverImage.large ?? null, color: e.media?.coverImage.color ?? null, score: e.score };
  };
  const hall = hallPicked.length ? { items: hallPicked.map(card), chosen: true } : { items: ratings.slice(0, 10).map((r) => card(r.id)), chosen: false };
  const hallOptions = self ? list.filter((e) => e.media).sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, 600)
    .map((e) => ({ id: e.anilistId, title: title(e), cover: e.media!.coverImage.large, color: e.media!.coverImage.color, score: e.score })) : [];

  // Кривая активности: часы по неделям из журнала просмотра
  const t = now();
  const start = t - 26 * WEEK;
  const log = db.prepare<[number, number], { at: number; minutes: number; episodes: number }>(
    "SELECT at, minutes, episodes FROM watch_log WHERE user_id = ? AND at >= ?").all(ownerId, start);
  const weekly = log.length ? Array.from({ length: 26 }, (_, i) => {
    const from = start + i * WEEK;
    const items = log.filter((r) => r.at >= from && r.at < from + WEEK);
    return { week: from, hours: Math.round((items.reduce((s, r) => s + r.minutes, 0) / 60) * 10) / 10, episodes: items.reduce((s, r) => s + r.episodes, 0) };
  }) : null;

  const res: ProfileStatsResponse = {
    stats, achievements,
    portrait: p?.portrait_ru ? { text: p.portrait_ru, likes: p.likes ?? [], dislikes: p.dislikes ?? [] } : null,
    banner: b ? { id: b.anilistId, title: title(b), image: b.media!.bannerImage!, chosen: Boolean(chosen) } : null,
    bannerOptions: self ? withBanner.slice(0, 120).map((e) => ({ id: e.anilistId, title: title(e), image: e.media!.bannerImage!, score: e.score })) : [],
    showcase, hall, hallOptions, ratings, weekly,
  };
  return json(res);
});
