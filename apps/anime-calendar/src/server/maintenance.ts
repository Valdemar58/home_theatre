import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

export type Maintenance = { id: string; label: string; startsAt: number; endsAt: number };
export const maintenancePath = () => path.join(process.env.DATA_DIR ?? "./data", "maintenance.json");
export function maintenance(): Maintenance | null {
  try {
    const value = JSON.parse(readFileSync(maintenancePath(), "utf8"));
    if (!/^[a-f0-9]{24}$/.test(value.id) || typeof value.label !== "string" || value.label.length > 100 ||
        !Number.isSafeInteger(value.startsAt) || !Number.isSafeInteger(value.endsAt) || value.endsAt <= value.startsAt)
      throw new Error("Invalid maintenance plan");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A broken control file must not silently admit new work during an update.
    return { id: "invalid", label: "Обслуживание сервера", startsAt: 0, endsAt: 1 };
  }
}
export const maintenanceActive = () => { const value = maintenance(); return !!value && Date.now() >= value.startsAt; };
export function maintenanceProgressAllowed(method: string, pathname: string) {
  const value = maintenance();
  return !!value && Date.now() >= value.startsAt && Date.now() < value.startsAt + 10000 &&
    (method === "POST" || method === "DELETE") && /^\/api\/play\/[a-zA-Z0-9_-]{1,128}$/.test(pathname);
}
export const MAINTENANCE_MESSAGE = "Сервер обновляется. Просмотр приостановлен, позиция сохранена.";
const global = globalThis as unknown as { __maintenanceWork?: Map<string, number> };
const work = global.__maintenanceWork ??= new Map<string, number>();
export function beginMaintenanceWork(name: string) {
  work.set(name, (work.get(name) ?? 0) + 1);
  let ended = false;
  return () => { if (!ended) { ended = true; work.set(name, Math.max(0, (work.get(name) ?? 1) - 1)); } };
}
export const maintenanceWork = () => [...work].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }));
