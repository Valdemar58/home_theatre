import "server-only";
import { cached, getCached } from "../cache";
import { env } from "../env";
import { RateLimiter } from "../http";
import { parseTopic, type TopicInfo } from "./topic-parse";

// Страницы тем RuTracker закрыты проверкой Cloudflare. FlareSolverr проходит её один раз
// (~10 с) и отдаёт куки; дальше страницы качаем обычным запросом с ними (~0,3 с).

type Clearance = { cookie: string; userAgent: string; expires: number };

let clearance: Clearance | null = null;
let refreshing: Promise<{ clearance: Clearance; html: string; url: string }> | null = null;
const limiter = new RateLimiter(300);

async function viaFlareSolverr(url: string): Promise<{ clearance: Clearance; html: string; url: string }> {
  const res = await fetch(`${env.flaresolverrUrl}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000 }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json()) as {
    status: string;
    message?: string;
    solution?: { status: number; response: string; userAgent: string; cookies: { name: string; value: string }[] };
  };
  if (data.status !== "ok" || !data.solution) throw new Error(`FlareSolverr: ${data.message ?? data.status}`);
  const s = data.solution;
  return {
    clearance: { cookie: s.cookies.map((c) => `${c.name}=${c.value}`).join("; "), userAgent: s.userAgent, expires: Date.now() + 30 * 60_000 },
    html: s.response,
    url,
  };
}

const blocked = (status: number, html: string) => status === 403 || status === 503 || html.includes("<title>Just a moment");

export async function fetchTopicHtml(url: string, attempt = 0): Promise<string> {
  if (clearance && clearance.expires > Date.now()) {
    const c = clearance;
    const res = await limiter.run(() =>
      fetch(url, { headers: { "User-Agent": c.userAgent, Cookie: c.cookie }, signal: AbortSignal.timeout(20_000) }));
    const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? "windows-1251";
    const html = new TextDecoder(charset).decode(await res.arrayBuffer());
    if (!blocked(res.status, html)) return html;
  }
  // Куки истекли или их нет: один запрос через FlareSolverr на всех
  refreshing ??= viaFlareSolverr(url).finally(() => {
    refreshing = null;
  });
  const fresh = await refreshing;
  clearance = fresh.clearance;
  // Общий запрос к FlareSolverr делал кто-то один: его HTML годится только для его адреса,
  // остальные перекачивают свою страницу уже со свежими куками
  if (fresh.url === url && fresh.html.includes("maintitle")) return fresh.html;
  if (attempt >= 2) throw new Error("RuTracker не отдал страницу темы");
  return fetchTopicHtml(url, attempt + 1);
}

const topicId = (url: string) => /[?&]t=(\d+)/.exec(url)?.[1];
const key = (url: string) => `ru:topic:${topicId(url) ?? url}`;

/** Сведения о теме из кэша, без сетевых запросов. */
export const cachedTopic = (url: string) => getCached<TopicInfo>(key(url));

/** Сведения о теме (название, озвучки); кэш на 30 дней. */
export const topicInfo = (url: string) =>
  cached(key(url), 30 * 86400, async () => {
    const html = await fetchTopicHtml(url);
    // Страница должна быть именно этой темой (защита от перепутанных ответов)
    const id = topicId(url);
    if (id && !html.includes(`t=${id}`)) throw new Error(`получена страница другой темы вместо ${id}`);
    return parseTopic(html);
  });

// ---------------------------------------------------------------- фоновая догрузка

const queue = new Set<string>();
let running = false;

/** Догрузить темы в фоне: следующий поиск уже покажет студии. */
export function prefetchTopics(urls: string[]) {
  for (const u of urls) if (!cachedTopic(u)) queue.add(u);
  if (running || !queue.size) return;
  running = true;
  void (async () => {
    while (queue.size) {
      const url = queue.values().next().value!;
      queue.delete(url);
      await topicInfo(url).catch((e) => console.warn(`[ru] тема ${url}: ${String(e)}`));
    }
    running = false;
  })();
}
