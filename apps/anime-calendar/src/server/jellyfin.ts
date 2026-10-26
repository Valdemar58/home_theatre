import "server-only";
import { env } from "./env";

const AUTH = 'MediaBrowser Client="Anime Calendar", Device="Server", DeviceId="anime-calendar", Version="1.0"';

/** Проверка логина/пароля через Jellyfin. Токен Jellyfin не храним, нужен только факт входа. */
export async function jellyfinLogin(username: string, password: string) {
  const res = await fetch(`${env.jellyfinUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Jellyfin: HTTP ${res.status}`);
  const data = (await res.json()) as { User: { Id: string; Name: string; Policy?: { IsAdministrator?: boolean } } };
  return { id: data.User.Id, name: data.User.Name, isAdmin: Boolean(data.User.Policy?.IsAdministrator) };
}
