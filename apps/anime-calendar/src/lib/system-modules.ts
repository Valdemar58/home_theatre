export type ModuleState = "not_configured" | "available" | "unreachable" | "unauthorized" | "needs_setup";
export const SYSTEM_MODULE_IDS = ["prowlarr", "sonarr", "jellyfin", "seerr", "ollama", "mapvec", "upscaler", "suwayomi", "unleash"] as const;
export type SystemModule = {
  id: string;
  name: string;
  purpose: string;
  state: ModuleState;
  detail: string;
  managed: boolean;
  version: string | null;
  publicUrl: string | null;
};
export type SystemModulesView = { contractVersion: 1; checkedAt: number; managed: boolean; modules: SystemModule[] };
export const MODULE_STATE_LABELS: Record<ModuleState, string> = {
  not_configured: "Не подключён", available: "Доступен", unreachable: "Нет соединения",
  unauthorized: "Проверьте доступ", needs_setup: "Нужна настройка",
};

/** Настройка возможности и здоровье соединения различаются: временный сбой не удаляет данные. */
export function integrationCapabilities(config: {
  prowlarrUrl: string; prowlarrApiKey: string; sonarrUrl: string; sonarrApiKey: string;
  jellyfinUrl: string; jellyfinApiKey: string; torrserverUrl: string;
}) {
  const search = Boolean(config.prowlarrUrl && config.prowlarrApiKey);
  return {
    search,
    serverDownload: Boolean(search && config.sonarrUrl && config.sonarrApiKey),
    serverStream: Boolean(search && config.jellyfinUrl && config.jellyfinApiKey && config.torrserverUrl),
  };
}
