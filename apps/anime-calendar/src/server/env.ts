import "server-only";

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const env = {
  dataDir: process.env.DATA_DIR ?? "./data",
  jellyfinUrl: trimSlash(process.env.JELLYFIN_URL ?? "http://localhost:8096"),
  seerrUrl: trimSlash(process.env.SEERR_URL ?? "http://localhost:5055"),
  /** Адрес Seerr для ссылок в браузере (внутренний docker-адрес браузеру недоступен) */
  seerrPublicUrl: trimSlash(process.env.SEERR_PUBLIC_URL ?? "http://localhost:5055"),
  seerrApiKey: process.env.SEERR_API_KEY ?? "",
  /** Ссылки на сервисы системы (меню «Сервисы») */
  servicesPublic: {
    sonarr: trimSlash(process.env.SONARR_PUBLIC_URL ?? "http://localhost:8989"),
    radarr: trimSlash(process.env.RADARR_PUBLIC_URL ?? "http://localhost:7878"),
    prowlarr: trimSlash(process.env.PROWLARR_PUBLIC_URL ?? "http://localhost:9696"),
    bazarr: trimSlash(process.env.BAZARR_PUBLIC_URL ?? "http://localhost:6767"),
    qbittorrent: trimSlash(process.env.QBIT_PUBLIC_URL ?? "http://localhost:8090"),
    torrserver: trimSlash(process.env.TORRSERVER_PUBLIC_URL ?? "http://localhost:8092"),
  },
  shikiUrl: trimSlash(process.env.SHIKIMORI_URL ?? "https://shikimori.io"),
  shikiClientId: process.env.SHIKIMORI_CLIENT_ID ?? "",
  shikiClientSecret: process.env.SHIKIMORI_CLIENT_SECRET ?? "",
  /** По умолчанию OOB: Shikimori показывает код, его вставляют в настройках */
  shikiRedirectUri: process.env.SHIKIMORI_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob",
  /** Shikimori требует User-Agent с названием зарегистрированного приложения */
  shikiAppName: process.env.SHIKIMORI_APP_NAME || "home-theater-anime-calendar",
  /** AniLib: сайт (для ссылок; домен у них меняется) и общий Lib-API */
  anilibUrl: trimSlash(process.env.ANILIB_URL ?? "https://v5.animelib.org"),
  anilibApi: trimSlash(process.env.ANILIB_API ?? "https://api.cdnlibs.org/api"),
  sessionSecret: process.env.SESSION_SECRET ?? "",
  // RU-индексатор: Sonarr ищет раздачи через нас, мы — через Prowlarr
  sonarrUrl: trimSlash(process.env.SONARR_URL ?? "http://localhost:8989"),
  sonarrApiKey: process.env.SONARR_API_KEY ?? "",
  prowlarrUrl: trimSlash(process.env.PROWLARR_URL ?? "http://localhost:9696"),
  prowlarrApiKey: process.env.PROWLARR_API_KEY ?? "",
  /** Ключ, с которым Sonarr обращается к нашему Torznab */
  torznabApiKey: process.env.TORZNAB_API_KEY ?? "",
  /** Тег индексаторов Prowlarr, раздачи которых разбирает RU-индексатор */
  ruIndexerTag: process.env.RU_INDEXER_TAG ?? "ru",
  /** Для страниц тем RuTracker за Cloudflare */
  flaresolverrUrl: trimSlash(process.env.FLARESOLVERR_URL ?? "http://localhost:8191"),
  // «Смотреть сейчас»: TorrServer + библиотека Jellyfin «Стрим»
  torrserverUrl: trimSlash(process.env.TORRSERVER_URL ?? "http://localhost:8092"),
  /** Адрес TorrServer, по которому к нему ходит Jellyfin (пишется в .strm) */
  torrserverInternalUrl: trimSlash(process.env.TORRSERVER_INTERNAL_URL ?? process.env.TORRSERVER_URL ?? "http://torrserver:8090"),
  streamDir: process.env.STREAM_DIR ?? "./data/stream",
  jellyfinApiKey: process.env.JELLYFIN_API_KEY ?? "",
  /** Та же папка стрима, но путь внутри контейнера Jellyfin */
  jellyfinStreamPath: process.env.JELLYFIN_STREAM_PATH ?? "/data/media/stream",
  jellyfinPublicUrl: trimSlash(process.env.JELLYFIN_PUBLIC_URL ?? "http://localhost:8096"),
  // Единый вход (Authentik): внутренний адрес — для обмена кода и API, публичный — для браузера
  authUrl: trimSlash(process.env.AUTH_URL ?? "http://authentik:9000"),
  authPublicUrl: trimSlash(process.env.AUTH_PUBLIC_URL ?? ""),
  authClientId: process.env.AUTH_CLIENT_ID ?? "",
  authClientSecret: process.env.AUTH_CLIENT_SECRET ?? "",
  authApiToken: process.env.AUTH_API_TOKEN ?? "",
  /** Адрес календаря из интернета (https://<домен>) */
  publicUrl: trimSlash(process.env.PUBLIC_URL ?? ""),
};

export const ssoConfigured = () => Boolean(env.authPublicUrl && env.authClientId && env.authClientSecret);

export const shikimoriConfigured = () => Boolean(env.shikiClientId && env.shikiClientSecret);
export const seerrConfigured = () => Boolean(env.seerrApiKey);
