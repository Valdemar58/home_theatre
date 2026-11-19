import "server-only";
import { groupPermissions, hasGroupCapability, type GroupCapability } from "@/lib/group-policy";
import type { RoomPreset } from "@/lib/room";
import { db } from "./db";
import { ApiError } from "./route";

export function groupAccess(listId: number, userId: number) {
  const row = db.prepare<[number, number], { owner_id: number; preset: RoomPreset; permissions: string | null; status: string; control: number }>(
    `SELECT l.owner_id, l.preset, l.permissions, m.status, m.control FROM shared_lists l
     JOIN shared_list_members m ON m.list_id = l.id AND m.user_id = ? WHERE l.id = ?`).get(userId, listId);
  if (!row || row.status !== "member") throw new ApiError(403, "Нужно вступить в комнату");
  const permissions = groupPermissions(row.permissions, row.preset);
  const owner = row.owner_id === userId;
  const can = (key: GroupCapability) => hasGroupCapability(permissions, key, owner, row.permissions === null && Boolean(row.control));
  return { permissions, owner, can, legacy: row.permissions === null };
}

export function requireGroupCapability(listId: number, userId: number, key: GroupCapability) {
  if (!groupAccess(listId, userId).can(key)) throw new ApiError(403, "Действие недоступно: проверьте права в настройках комнаты");
}
