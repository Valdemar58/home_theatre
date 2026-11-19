import type { RoomPreset } from "./room";

export const GROUP_CAPABILITIES = ["suggest", "queue", "reorder", "vote", "schedule", "play", "host", "invite"] as const;
export type GroupCapability = typeof GROUP_CAPABILITIES[number];
export type GroupPermissions = Record<GroupCapability, "all" | "owner">;
export const DEFAULT_GROUP_PERMISSIONS: GroupPermissions = {
  suggest: "all", queue: "owner", reorder: "owner", vote: "all",
  schedule: "owner", play: "all", host: "all", invite: "owner",
};

/** Null policy preserves the old preset until the organizer saves explicit permissions. */
export function groupPermissions(raw: string | null, preset: RoomPreset): GroupPermissions {
  if (raw === null) return { ...DEFAULT_GROUP_PERMISSIONS, queue: "all", reorder: "all", invite: "all", schedule: preset === "equal" ? "all" : "owner", play: preset === "equal" ? "all" : "owner" };
  try {
    const value = JSON.parse(raw);
    return Object.fromEntries(GROUP_CAPABILITIES.map((key) => [key, value?.[key] === "all" ? "all" : value?.[key] === "owner" ? "owner" : DEFAULT_GROUP_PERMISSIONS[key]])) as GroupPermissions;
  } catch { return { ...DEFAULT_GROUP_PERMISSIONS }; }
}

export function hasGroupCapability(policy: GroupPermissions, key: GroupCapability, owner: boolean, legacyControl = false): boolean {
  return owner || policy[key] === "all" || (legacyControl && (key === "play" || key === "schedule"));
}
