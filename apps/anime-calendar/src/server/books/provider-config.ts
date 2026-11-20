import "server-only";
import { db, now } from "../db";

// Настройки провайдеров глав (карточка «Провайдеры» в Настройках, только админ): порядок, выключенные, токен Lib для 18+.
// Порядок — как провайдеры стоят на странице книги. Выключенный не ищет и не обновляет
// оглавления, его главы не показываются (привязки остаются — включили обратно, и всё на месте).

/** Мосты (TASKS 5.9): LNReader — адрес индекса плагинов и включённые плагины; Suwayomi — адрес сервера, репозиторий
 * расширений Mihon (задаёт пользователь) и источники, в которых искать книги. */
export type LnreaderConfig = { index: string; plugins: string[] };
export type SuwayomiConfig = { url: string; repo: string; sources: string[]; languages: string[] };
export type ProviderConfig = { order: string[]; disabled: string[]; libToken: string | null; lnreader: LnreaderConfig; suwayomi: SuwayomiConfig };
export const LNREADER_INDEX = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";
const KEY = "book-providers";

export function providerConfig(): ProviderConfig {
  const r = db.prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key = ?").get(KEY);
  const v = r ? (JSON.parse(r.value) as Partial<ProviderConfig>) : {};
  return {
    order: v.order ?? [], disabled: v.disabled ?? [], libToken: v.libToken ?? null,
    lnreader: { index: v.lnreader?.index || LNREADER_INDEX, plugins: v.lnreader?.plugins ?? [] },
    suwayomi: { url: v.suwayomi?.url ?? process.env.SUWAYOMI_URL ?? "http://suwayomi:4567", repo: v.suwayomi?.repo ?? "", sources: v.suwayomi?.sources ?? [], languages: v.suwayomi?.languages ?? ["ru", "en", "ja"] },
  };
}

export function saveProviderConfig(patch: Partial<ProviderConfig>) {
  const old = providerConfig();
  const next = { ...old, ...patch };
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(next), now());
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    // Новые источники должны находить книги сразу, а не ждать недельного отрицательного кэша.
    db.exec("UPDATE book_links SET checked_at = 0 WHERE how IN ('auto', 'none')");
  }
}

/** Токен Lib (из браузера, где выполнен вход) — открывает книги 18+. */
export const libToken = () => providerConfig().libToken;

/** Список провайдеров по порядку из настроек (новые, которых нет в порядке, — в конце). */
export function ordered<T extends { id: string }>(all: T[], cfg = providerConfig()): T[] {
  const rank = (id: string) => (cfg.order.includes(id) ? cfg.order.indexOf(id) : cfg.order.length + all.findIndex((p) => p.id === id));
  return [...all].sort((a, b) => rank(a.id) - rank(b.id));
}
