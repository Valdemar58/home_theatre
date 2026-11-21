import "server-only";
import { DEFAULT_SYNC_POLICY, syncPolicy, type SyncPolicy } from "@/lib/sync-policy";
import { db, now } from "./db";
import { ApiError } from "./route";
export function groupSyncPolicy(group: number | null): SyncPolicy {
  if (!group) return { ...DEFAULT_SYNC_POLICY };
  const row = db.prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key=?").get(`room-sync:${group}`);
  try { return row ? syncPolicy(JSON.parse(row.value)) : { ...DEFAULT_SYNC_POLICY }; } catch { return { ...DEFAULT_SYNC_POLICY }; }
}
export function saveGroupSyncPolicy(group: number, value: unknown) {
  let policy: SyncPolicy;
  try { policy = syncPolicy(value); } catch (e) { throw new ApiError(400, (e as Error).message); }
  db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(`room-sync:${group}`, JSON.stringify(policy), now());
}
