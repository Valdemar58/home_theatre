import { env, seerrConfigured, shikimoriConfigured } from "@/server/env";
import { authed, json } from "@/server/route";
import { setVisibility } from "@/server/social";
import { db } from "@/server/db";
import { isRemote } from "@/server/remote";
import type { Visibility } from "@/lib/social-rules";

export type Me = {
  id: number;
  name: string;
  /** Кому виден профиль и списки */
  visibility: Visibility;
  isAdmin: boolean;
  seerr: { configured: boolean; url: string };
  /** Сервисы системы для меню: admin — только админу */
  services: { id: string; name: string; hint: string; url: string; admin: boolean }[];
  /** RU-индексатор: выбор раздачи с озвучкой */
  ru: { configured: boolean; stream: boolean };
  shikimori: {
    configured: boolean;
    linked: boolean;
    nickname: string | null;
    syncedAt: number | null;
    error: string | null;
    url: string;
    oob: boolean;
  };
};

export const GET = authed(async (req, user) => {
  // Из интернета сервисы — на поддоменах за единым входом (apps/caddy/Caddyfile), дома — по портам
  const sub = (name: string, local: string) => (isRemote(req) && env.publicUrl ? env.publicUrl.replace("://", `://${name}.`) : local);
  const seerrUrl = sub("seerr", env.seerrPublicUrl);
  const me: Me = {
    id: user.id,
    name: user.name,
    visibility: user.visibility,
    isAdmin: Boolean(user.is_admin),
    seerr: { configured: seerrConfigured(), url: seerrUrl },
    services: [
      { id: "jellyfin", name: "Jellyfin", hint: "медиатека и плеер", url: sub("jellyfin", env.jellyfinPublicUrl), admin: false },
      ...(seerrConfigured() ? [{ id: "seerr", name: "Seerr", hint: "запросы фильмов и сериалов", url: seerrUrl, admin: false }] : []),
      { id: "sonarr", name: "Sonarr", hint: "сериалы и аниме: поиск и загрузка", url: sub("sonarr", env.servicesPublic.sonarr), admin: true },
      { id: "radarr", name: "Radarr", hint: "фильмы: поиск и загрузка", url: sub("radarr", env.servicesPublic.radarr), admin: true },
      { id: "prowlarr", name: "Prowlarr", hint: "трекеры и индексаторы", url: sub("prowlarr", env.servicesPublic.prowlarr), admin: true },
      { id: "bazarr", name: "Bazarr", hint: "субтитры", url: sub("bazarr", env.servicesPublic.bazarr), admin: true },
      { id: "qbittorrent", name: "qBittorrent", hint: "торрент-клиент", url: sub("qbit", env.servicesPublic.qbittorrent), admin: true },
      { id: "torrserver", name: "TorrServer", hint: "онлайн-просмотр торрентов", url: sub("torrserver", env.servicesPublic.torrserver), admin: true },
    ].filter((s) => !s.admin || user.is_admin),
    ru: { configured: Boolean(env.sonarrApiKey && env.prowlarrApiKey), stream: Boolean(env.jellyfinApiKey && env.prowlarrApiKey) },
    shikimori: {
      configured: shikimoriConfigured(),
      linked: Boolean(user.shiki_refresh),
      nickname: user.shiki_nickname,
      syncedAt: user.shiki_synced_at,
      error: user.shiki_error,
      url: env.shikiUrl,
      oob: env.shikiRedirectUri.startsWith("urn:"),
    },
  };
  return json(me);
});

export const PATCH = authed(async (req, user) => {
  const { visibility, profileBanner, showcase, hall } = (await req.json()) as { visibility?: string; profileBanner?: number | null; showcase?: string[] | null; hall?: number[] | null };
  if (visibility !== undefined) setVisibility(user.id, visibility);
  // Профиль: баннер (тайтл; null — по умолчанию) и витрина наград (до 6; null — самые прокачанные)
  if (profileBanner !== undefined) db.prepare("UPDATE users SET profile_banner = ? WHERE id = ?").run(profileBanner ? Number(profileBanner) : null, user.id);
  if (hall !== undefined) db.prepare("UPDATE users SET hall = ? WHERE id = ?").run(hall?.length ? hall.slice(0, 10).map(Number).join(",") : null, user.id);
  if (showcase !== undefined) db.prepare("UPDATE users SET showcase = ? WHERE id = ?").run(showcase?.length ? showcase.slice(0, 6).map(String).join(",") : null, user.id);
  return json({ ok: true });
});
