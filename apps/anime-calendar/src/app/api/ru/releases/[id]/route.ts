import { env } from "@/server/env";
import { adminOnly, ApiError, authed, intParam, json } from "@/server/route";
import type { VoicesState } from "@/lib/types";
import { grabRuRelease } from "@/server/ru/releases";
import { cachedVoices, latestTask } from "@/server/tasks";

const requireRu = () => {
  if (!env.sonarrApiKey || !env.prowlarrApiKey) throw new ApiError(400, "RU-индексатор не настроен (нет ключей Sonarr/Prowlarr)");
};

/**
 * Озвучки тайтла: что уже найдено (кэш фоновой задачи, любой давности) и идёт ли поиск.
 * Сам поиск — фоновая задача (POST /api/tasks { kind: "voices" }), ждать его здесь не нужно.
 */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  requireRu();
  const anilistId = intParam(id, "id");
  const hit = cachedVoices(anilistId);
  const state: VoicesState = { data: hit?.data ?? null, fetchedAt: hit?.at ?? null, task: latestTask("voices", String(anilistId)) };
  return json(state);
});

/** Скачать выбранную раздачу через Sonarr */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  requireRu();
  const { guid } = (await req.json().catch(() => ({}))) as { guid?: string };
  if (!guid) throw new ApiError(400, "Не выбрана раздача");
  const result = await grabRuRelease(intParam(id, "id"), guid);
  return json(result, result.ok ? 200 : 400);
});
