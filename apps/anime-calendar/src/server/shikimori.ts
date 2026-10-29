import "server-only";
import type { ListStatus } from "@/lib/types";
import { cached } from "./cache";
import { now, stmt } from "./db";
import { env } from "./env";
import { expectOk, fetchWithRetry, RateLimiter } from "./http";
import { guarded, sourceDown } from "./sources";

// Лимит Shikimori: 5 запросов/с и 90/мин
const limiter = new RateLimiter(700);

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": env.shikiAppName, Accept: "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function shiki<T>(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<T> {
  return guarded("shikimori", () => shikiRaw<T>(path, init));
}

async function shikiRaw<T>(path: string, init: RequestInit & { token?: string; json?: unknown }): Promise<T> {
  const { token, json, ...rest } = init;
  const res = await fetchWithRetry(
    env.shikiUrl + path,
    {
      ...rest,
      headers: { ...headers(token), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    },
    limiter,
  );
  await expectOk(res, `Shikimori ${path}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ---------------------------------------------------------------- русские названия и оценка MAL

export type ShikiInfo = { russian: string | null; score: number | null };

const getTitle = stmt<[number], { russian: string | null; score: number | null; fetched_at: number }>(
  "SELECT russian, score, fetched_at FROM titles_ru WHERE mal_id = ?");
const putTitle = stmt(
  "INSERT INTO titles_ru (mal_id, russian, score, fetched_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(mal_id) DO UPDATE SET russian = excluded.russian, score = excluded.score, fetched_at = excluded.fetched_at");

// По умолчанию (живость тайтла неизвестна) — как раньше: оценки онгоингов меняются каждую неделю
const TTL = 3 * 86400;
const refreshing = new Set<number>();

async function fetchInfo(batch: number[], result: Map<number, ShikiInfo>) {
  const data = await shiki<{ data: { animes: { id: string; russian: string | null; score: number | null }[] } }>(
    "/api/graphql",
    {
      method: "POST",
      json: { query: `{ animes(ids: "${batch.join(",")}", limit: 50) { id russian score } }` },
    },
  );
  const found = new Map(data.data.animes.map((a) => [Number(a.id), a]));
  const ts = now();
  for (const id of batch) {
    const a = found.get(id);
    const russian = a?.russian?.trim() || null;
    // 0 у Shikimori означает «оценок ещё нет»
    const score = a?.score ?? 0;
    putTitle().run(id, russian, score, ts);
    result.set(id, { russian, score: score || null });
  }
}

/**
 * Русские названия и оценки по MAL ID. Оценка Shikimori — это копия оценки MAL. Сохранённое отдаётся всегда;
 * устаревшее (ttl — по живости тайтла, вышедший давно — 90 дней) обновляется в фоне, ждём только то, чего нет вовсе.
 */
export async function shikiInfo(malIds: number[], ttl: (malId: number) => number = () => TTL): Promise<Map<number, ShikiInfo>> {
  const result = new Map<number, ShikiInfo>();
  const missing: number[] = [];
  const stale: number[] = [];
  for (const id of new Set(malIds)) {
    const row = getTitle().get(id);
    if (row) result.set(id, { russian: row.russian, score: row.score || null });
    // score IS NULL — запись из версии без оценок
    if (!row) missing.push(id);
    else if ((row.score === null || row.fetched_at < now() - ttl(id)) && !refreshing.has(id)) stale.push(id);
  }
  if (sourceDown("shikimori")) return result;
  for (let i = 0; i < missing.length; i += 50) {
    try {
      await fetchInfo(missing.slice(i, i + 50), result);
    } catch (err) {
      // Без русских названий и оценок MAL всё работает (покажем данные AniList)
      console.warn(`[shikimori] названия: ${String(err)}`);
      break;
    }
  }
  if (stale.length) {
    stale.forEach((id) => refreshing.add(id));
    void (async () => {
      for (let i = 0; i < stale.length; i += 50) await fetchInfo(stale.slice(i, i + 50), new Map()).catch(() => undefined);
    })().finally(() => stale.forEach((id) => refreshing.delete(id)));
  }
  return result;
}

/**
 * Поиск Shikimori (русские, английские, японские названия и синонимы) → MAL id по релевантности.
 * AniList по-русски не ищет: «Комбатанты» находились только как «Combatants».
 */
export function shikiSearch(q: string, limit: number, page = 1): Promise<number[]> {
  const query = q.trim().toLowerCase().replace(/\s+/g, " ");
  return cached(`shiki-search:${limit}:${page}:${query}`, { fresh: 86400, source: "shikimori" }, async () => {
    const data = await shiki<{ data: { animes: { id: string }[] } }>("/api/graphql", {
      method: "POST",
      json: { query: `{ animes(search: ${JSON.stringify(query)}, limit: ${limit}, page: ${page}) { id } }` },
    });
    return data.data.animes.map((a) => Number(a.id));
  });
}

/** Описание на русском. BB-коды Shikimori ([character=1]Имя[/character]) убираются. */
export function ruDescription(malId: number): Promise<string | null> {
  // Описания меняются редко: проверяем раз в 30 дней, в фоне
  return cached(`shiki-desc:${malId}`, { fresh: 30 * 86400, source: "shikimori" }, async () => {
    const data = await shiki<{ data: { animes: { description: string | null }[] } }>("/api/graphql", {
      method: "POST",
      json: { query: `{ animes(ids: "${malId}", limit: 1) { description } }` },
    });
    const raw = data.data.animes[0]?.description;
    if (!raw) return null;
    return raw.replace(/\[\/?[a-z_]+(=[^\]]*)?\]/gi, "").replace(/\r/g, "").trim() || null;
  });
}

// ---------------------------------------------------------------- OAuth

export type Tokens = { access_token: string; refresh_token: string; expires_in: number; created_at: number };

/**
 * Куда Shikimori вернёт код: из интернета (календарь на домене) — сразу на callback, дома — OOB (код вставляют руками:
 * сессия на localhost/адресе в сети, а не на домене). В приложении Shikimori заведены оба адреса.
 */
export const shikiRedirectFor = (remote: boolean) =>
  remote && env.publicUrl ? `${env.publicUrl}/api/shikimori/callback` : env.shikiRedirectUri;

export function authorizeUrl(state: string, redirectUri = env.shikiRedirectUri): string {
  const p = new URLSearchParams({
    client_id: env.shikiClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "user_rates",
    state,
  });
  return `${env.shikiUrl}/oauth/authorize?${p}`;
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetchWithRetry(
    `${env.shikiUrl}/oauth/token`,
    {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.shikiClientId, client_secret: env.shikiClientSecret, ...params }),
    },
    limiter,
  );
  await expectOk(res, "Shikimori OAuth");
  return (await res.json()) as Tokens;
}

export const exchangeCode = (code: string, redirectUri = env.shikiRedirectUri) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refreshTokens = (refresh: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });

export const whoami = (token: string) => shiki<{ id: number; nickname: string }>("/api/users/whoami", { token });

// ---------------------------------------------------------------- списки

export type ShikiRate = {
  id: number;
  target_id: number;
  status: ListStatus;
  episodes: number;
  score: number;
  updated_at: string;
};

export async function listRates(userId: number, token: string): Promise<ShikiRate[]> {
  const all: ShikiRate[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await shiki<ShikiRate[]>(
      `/api/v2/user_rates?user_id=${userId}&target_type=Anime&page=${page}&limit=1000`, { token });
    all.push(...batch);
    if (batch.length < 1000) break;
  }
  return all;
}

type RatePayload = { status: ListStatus; episodes: number; score: number };

export const createRate = (token: string, userId: number, malId: number, rate: RatePayload) =>
  shiki<ShikiRate>("/api/v2/user_rates", {
    method: "POST",
    token,
    json: { user_rate: { user_id: userId, target_id: malId, target_type: "Anime", ...rate } },
  });

export const updateRate = (token: string, rateId: number, rate: RatePayload) =>
  shiki<ShikiRate>(`/api/v2/user_rates/${rateId}`, { method: "PATCH", token, json: { user_rate: rate } });

export const deleteRate = (token: string, rateId: number) =>
  shiki<null>(`/api/v2/user_rates/${rateId}`, { method: "DELETE", token });
