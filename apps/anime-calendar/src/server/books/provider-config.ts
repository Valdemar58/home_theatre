import "server-only";
import { db, now } from "../db";

// Настройки провайдеров глав (карточка «Провайдеры» в Настройках, только админ): порядок, выключенные, токен Lib для 18+.
// Порядок — как провайдеры стоят на странице книги. Выключенный не ищет и не обновляет
// оглавления, его главы не показываются (привязки остаются — включили обратно, и всё на месте).

export type ProviderConfig = { order: string[]; disabled: string[]; libToken: string | null };
const KEY = "book-providers";

export function providerConfig(): ProviderConfig {
  const r = db.prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key = ?").get(KEY);
  const v = r ? (JSON.parse(r.value) as Partial<ProviderConfig>) : {};
  return { order: v.order ?? [], disabled: v.disabled ?? [], libToken: v.libToken ?? null };
}

export function saveProviderConfig(patch: Partial<ProviderConfig>) {
  const next = { ...providerConfig(), ...patch };
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(KEY, JSON.stringify(next), now());
}

/** Токен Lib (из браузера, где выполнен вход) — открывает книги 18+. */
export const libToken = () => providerConfig().libToken;

/** Список провайдеров по порядку из настроек (новые, которых нет в порядке, — в конце). */
export function ordered<T extends { id: string }>(all: T[], cfg = providerConfig()): T[] {
  const rank = (id: string) => (cfg.order.includes(id) ? cfg.order.indexOf(id) : cfg.order.length + all.findIndex((p) => p.id === id));
  return [...all].sort((a, b) => rank(a.id) - rank(b.id));
}
