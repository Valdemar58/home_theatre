import "server-only";
import { env } from "./env";
import { providerConfig } from "./books/provider-config";
import type { SystemModule, SystemModulesView } from "@/lib/system-modules";

type Probe = {
  id: string; name: string; purpose: string; url: string; path: string; key?: string;
  requiresKey?: boolean; publicUrl?: string; profile?: string; inspect?: "version" | "indexers" | "models" | "suwayomi";
  authHeader?: "Authorization";
};
const profiles = () => new Set((process.env.HOME_THEATER_MODULES ?? "").split(",").filter(Boolean));
const definitions = (): Probe[] => [
  { id: "unleash", name: "Управление функциями", purpose: "Разрешение ИИ-операций. При сбое сохраняются последние решения; локальное отключение имеет приоритет.", url: process.env.UNLEASH_URL ?? "", path: "client/features", key: process.env.UNLEASH_API_TOKEN, requiresKey: true, authHeader: "Authorization", profile: "flags", publicUrl: process.env.UNLEASH_PUBLIC_URL },
  { id: "prowlarr", name: "Поиск раздач", purpose: "Поиск для desktop. Скачивание выполняется на устройстве.", url: env.prowlarrUrl, path: "/api/v1/indexer", key: env.prowlarrApiKey, requiresKey: true, profile: "search", inspect: "indexers", publicUrl: env.servicesPublic.prowlarr },
  { id: "sonarr", name: "Sonarr", purpose: "Существующий серверный путь скачивания; для desktop не требуется.", url: env.sonarrUrl, path: "/api/v3/system/status", key: env.sonarrApiKey, requiresKey: true, inspect: "version", publicUrl: env.servicesPublic.sonarr },
  { id: "jellyfin", name: "Jellyfin", purpose: "Существующая медиатека и серверный плеер. Desktop-хосты работают отдельно.", url: env.jellyfinUrl, path: "/System/Info/Public", inspect: "version", publicUrl: env.jellyfinPublicUrl },
  { id: "seerr", name: "Seerr", purpose: "Запросы в существующую серверную медиатеку.", url: env.seerrUrl, path: "/api/v1/status", key: env.seerrApiKey, requiresKey: true, inspect: "version", publicUrl: env.seerrPublicUrl },
  { id: "ollama", name: "Локальный ИИ", purpose: "Ollama и локальные модели. Сохранённые знания доступны без него.", url: process.env.OLLAMA_URL ?? "", path: "/api/tags", profile: "llm", inspect: "models" },
  { id: "mapvec", name: "Распознавание карт и текста", purpose: "Дополнительный анализ изображений. Данные персонажей из API сохраняются.", url: process.env.MAPVEC_URL ?? "", path: "/health" },
  { id: "upscaler", name: "Улучшение изображений", purpose: "Увеличение изображений; без компонента показываются оригиналы.", url: process.env.UPSCALER_URL ?? "", path: "/health" },
  { id: "suwayomi", name: "Suwayomi", purpose: "Дополнительные источники манги. Другие провайдеры работают отдельно.", url: providerConfig().suwayomi.url, path: "/api/graphql", inspect: "suwayomi" },
];

const publicOrigin = (value?: string) => {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin + url.pathname : null;
  } catch { return null; }
};

/** Только заранее настроенные endpoints; пользователь не может передать URL для произвольного запроса. */
export async function probeModule(probe: Probe, fetcher: typeof fetch = fetch): Promise<SystemModule> {
  const managed = Boolean(probe.profile && profiles().has(probe.profile));
  const base: SystemModule = {
    id: probe.id, name: probe.name, purpose: probe.purpose, state: "not_configured",
    detail: "Необязательный компонент. Остальные функции продолжают работать.", managed,
    version: null, publicUrl: publicOrigin(probe.publicUrl),
  };
  if (!probe.url) return base;
  if (probe.requiresKey && !probe.key) return { ...base, state: "needs_setup", detail: "Адрес задан, но ключ доступа не настроен." };
  try {
    const endpoint = new URL(probe.path, probe.url.endsWith("/") ? probe.url : probe.url + "/");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      return { ...base, state: "needs_setup", detail: "Проверьте адрес компонента в конфигурации сервера." };
    const response = await fetcher(endpoint, {
      method: probe.inspect === "suwayomi" ? "POST" : "GET",
      body: probe.inspect === "suwayomi" ? JSON.stringify({ query: "{ aboutServer { version } }" }) : undefined,
      headers: { Accept: "application/json", ...(probe.key ? { [probe.authHeader ?? "X-Api-Key"]: probe.key } : {}), ...(probe.inspect === "suwayomi" ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(2500), redirect: "error", cache: "no-store",
    });
    if ([401, 403].includes(response.status)) return { ...base, state: "unauthorized", detail: "Компонент ответил, но отклонил доступ. Проверьте ключ." };
    if (!response.ok) return { ...base, state: "unreachable", detail: `Компонент ответил HTTP ${response.status}. Повторите проверку после настройки.` };
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 256_000) return { ...base, state: "needs_setup", detail: "Ответ не похож на служебный API компонента." };
    const body: unknown = await response.json();
    if (probe.inspect === "suwayomi") {
      const version = (body as { data?: { aboutServer?: { version?: unknown } } })?.data?.aboutServer?.version;
      if (typeof version !== "string") throw new Error("Unexpected bridge response");
      return { ...base, state: "available", version: version.slice(0,80), detail: "Соединение с API работает. Расширения и источники настраиваются в разделе «Мосты к расширениям»." };
    }
    if (probe.inspect === "indexers") {
      if (!Array.isArray(body)) throw new Error("Unexpected indexer response");
      const active = body.filter((entry: { enable?: boolean }) => entry?.enable).length;
      return { ...base, state: active ? "available" : "needs_setup", detail: active ? `Подключённых индексаторов: ${active}. Доступность конкретной раздачи проверяется поиском.` : "Prowlarr доступен. Добавьте и включите индексаторы в его настройках." };
    }
    if (probe.inspect === "models") {
      const models = (body as { models?: unknown[] })?.models;
      if (!Array.isArray(models)) throw new Error("Unexpected model response");
      return { ...base, state: models.length ? "available" : "needs_setup", detail: models.length ? `Установлено моделей: ${models.length}. Назначения моделей настраиваются в разделе «ИИ».` : "Ollama доступна, но модели ещё не установлены." };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Unexpected API response");
    const data = body as { version?: unknown; Version?: unknown; status?: unknown };
    const version = data.version ?? data.Version;
    return { ...base, state: "available", version: typeof version === "string" ? version.slice(0, 80) : null,
      detail: "Соединение с API работает. Медиа и пользовательские операции проверяются отдельно." };
  } catch {
    // Ни URL с query, ни тексты upstream-ошибок с ключами не отправляем в браузер.
    return { ...base, state: "unreachable", detail: "Не удалось подключиться. Проверьте запуск компонента, адрес и сетевой доступ." };
  }
}

let latest: SystemModulesView | null = null;
let pending: Promise<SystemModulesView> | null = null;
export async function systemModules(): Promise<SystemModulesView> {
  if (latest && Date.now() - latest.checkedAt < 5000) return latest;
  if (pending) return pending;
  pending = Promise.all(definitions().map(probe => probeModule(probe))).then(modules => {
    latest = { contractVersion: 1, checkedAt: Date.now(), managed: process.env.HOME_THEATER_MODULES !== undefined, modules };
    return latest;
  }).finally(() => { pending = null; });
  return pending;
}
