import "server-only";

// Доступ снаружи (TASKS 9.4б): календарь открыт в интернет через Caddy (HTTPS, pivocinema.duckdns.org). Caddy ставит
// X-Forwarded-For (адрес клиента, чужой заголовок заменяет) и X-Public-Access — запрос пришёл из интернета, а не из дома.

/** Пришёл из интернета (через Caddy). */
export const isRemote = (req: Request) => req.headers.get("x-public-access") === "1";

/** Адрес клиента: из интернета — от Caddy, дома — неважен. */
export const clientIp = (req: Request) =>
  isRemote(req) ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?") : "local";

// Неудачные входы по адресу: 8 за 15 минут — дальше ждать (перебор паролей Jellyfin снаружи)
const FAIL_WINDOW = 15 * 60_000;
const FAIL_MAX = 8;
const fails = new Map<string, number[]>();

/** Сколько секунд ещё ждать этому адресу (0 — можно пробовать). */
export function loginWait(ip: string): number {
  const now = Date.now();
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW);
  fails.set(ip, recent);
  return recent.length >= FAIL_MAX ? Math.ceil((recent[0] + FAIL_WINDOW - now) / 1000) : 0;
}

export function loginFailed(ip: string) {
  fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
}

export const loginOk = (ip: string) => fails.delete(ip);
