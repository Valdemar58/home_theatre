import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db, now } from "./db";
import { ApiError } from "./route";
import { groupAccess, requireGroupCapability } from "./group-policy";

type Device = {
  id: string;
  token_hash: string;
  user_id: number | null;
  label: string;
  platform: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  revoked: number;
  inventory: string;
};
export type HostFile = {
  preparedVersion?: string;
  preparedBytes?: number;
  duration?: number;
  id: string;
  title: number;
  ep: number;
  version: string;
  bytes: number;
  state: "imported" | "preparing" | "ready" | "error";
  progress: number;
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function beginPairing(label: unknown, platform: unknown) {
  if (
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 80 ||
    !["win32", "linux"].includes(String(platform))
  )
    throw new ApiError(400, "Некорректное устройство");
  db.prepare(
    "DELETE FROM desktop_devices WHERE user_id IS NULL AND expires_at < ?",
  ).run(now());
  const count = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM desktop_devices WHERE user_id IS NULL",
    )
    .get()!.n;
  if (count >= 100)
    throw new ApiError(
      429,
      "Слишком много запросов привязки. Попробуйте позже",
    );
  const id = randomBytes(12).toString("hex"),
    token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO desktop_devices (id,token_hash,label,platform,created_at,expires_at) VALUES (?,?,?,?,?,?)",
  ).run(id, digest(token), label.trim(), platform, now(), now() + 600);
  return { id, token, expiresAt: now() + 600 };
}
export function pairingInfo(id: string) {
  const d = db
    .prepare<[string], Device>("SELECT * FROM desktop_devices WHERE id=?")
    .get(id);
  if (!d || d.revoked || d.user_id || d.expires_at < now())
    throw new ApiError(410, "Код истёк или уже использован");
  return { id: d.id, label: d.label, platform: d.platform };
}
export function approveDevice(id: string, user: number) {
  pairingInfo(id);
  const result = db
    .prepare(
      "UPDATE desktop_devices SET user_id=? WHERE id=? AND user_id IS NULL AND revoked=0 AND expires_at>=?",
    )
    .run(user, id, now());
  if (result.changes !== 1)
    throw new ApiError(409, "Код уже использован или истёк");
}
export function deviceByToken(token: string, pending = false) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new ApiError(401, "Устройство не привязано");
  const d = db
    .prepare<[string], Device>(
      "SELECT * FROM desktop_devices WHERE token_hash=?",
    )
    .get(digest(token));
  if (!d || d.revoked || (!d.user_id && (!pending || d.expires_at < now())))
    throw new ApiError(401, "Доступ устройства отозван или истёк");
  if (d.user_id) {
    const u = db
      .prepare<[number], { blocked: number }>(
        "SELECT blocked FROM users WHERE id=?",
      )
      .get(d.user_id);
    if (!u || u.blocked) throw new ApiError(401, "Аккаунт недоступен");
  }
  return d;
}
export function inventoryInput(value: unknown): HostFile[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new ApiError(400, "Слишком большая библиотека устройства");
  const ids = new Set<string>();
  return value.map((f) => {
    if (
      !f ||
      typeof f.id !== "string" ||
      !/^[a-f0-9-]{16,64}$/.test(f.id) ||
      ids.has(f.id) ||
      !Number.isSafeInteger(f.title) ||
      f.title <= 0 ||
      !Number.isSafeInteger(f.ep) ||
      f.ep <= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(f.version) ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes <= 0 ||
      !["imported", "preparing", "ready", "error"].includes(f.state) ||
      !Number.isFinite(f.progress) ||
      f.progress < 0 ||
      f.progress > 1
    )
      throw new ApiError(400, "Некорректная библиотека");
    ids.add(f.id);
    const prepared = /^sha256:[a-f0-9]{64}$/.test(f.preparedVersion) && Number.isSafeInteger(f.preparedBytes) && f.preparedBytes > 0 && Number.isFinite(f.duration) && f.duration > 0 && f.duration < 86400;
    return {
      ...(prepared ? { preparedVersion: f.preparedVersion, preparedBytes: f.preparedBytes, duration: f.duration } : {}),
      id: f.id,
      title: f.title,
      ep: f.ep,
      version: f.version,
      bytes: f.bytes,
      state: f.state,
      progress: f.state === "ready" ? 1 : f.progress,
    };
  });
}
export function heartbeat(d: Device, files: unknown) {
  const clean = inventoryInput(files);
  db.prepare(
    "UPDATE desktop_devices SET last_seen=?, inventory=? WHERE id=? AND revoked=0",
  ).run(now(), JSON.stringify(clean), d.id);
}
export function setGrant(
  d: Device,
  list: number,
  title: number,
  enabled: boolean,
) {
  if (!d.user_id) throw new ApiError(401, "Привяжите устройство");
  if (
    !Number.isSafeInteger(list) ||
    list <= 0 ||
    !Number.isSafeInteger(title) ||
    title <= 0
  )
    throw new ApiError(400, "Некорректный тайтл или комната");
  if (!enabled) {
    db.prepare(
      "DELETE FROM desktop_grants WHERE device_id=? AND list_id=? AND anilist_id=?",
    ).run(d.id, list, title);
    return;
  }
  requireGroupCapability(list, d.user_id, "host");
  if (!(JSON.parse(d.inventory) as HostFile[]).some((f) => f.title === title))
    throw new ApiError(400, "Сначала подключите файл тайтла");
  db.prepare(
    "INSERT INTO desktop_grants (device_id,list_id,anilist_id) VALUES (?,?,?) ON CONFLICT DO NOTHING",
  ).run(d.id, list, title);
}
export function revokeDevice(id: string, user: number) {
  db.prepare(
    "UPDATE desktop_devices SET revoked=1,last_seen=0,inventory='[]' WHERE id=? AND user_id=?",
  ).run(id, user);
}
export function setOwnedGrant(user: number, device: string, room: number, title: number, enabled: boolean) {
  const d = db.prepare<[string, number], Device>("SELECT * FROM desktop_devices WHERE id=? AND user_id=? AND revoked=0").get(device, user);
  if (!d) throw new ApiError(404, "Устройство не найдено");
  setGrant(d, room, title, enabled);
}
export function ownDevices(user: number) {
  return db
    .prepare<
      [number],
      {
        id: string;
        label: string;
        platform: string;
        last_seen: number;
        revoked: number;
      }
    >(
      "SELECT id,label,platform,last_seen,revoked FROM desktop_devices WHERE user_id=? ORDER BY created_at DESC",
    )
    .all(user)
    .map((d) => ({ ...d, online: !d.revoked && d.last_seen > now() - 45 }));
}
export function hostRooms(user: number) {
  return db
    .prepare<[number], { id: number; name: string }>(
      "SELECT l.id,l.name FROM shared_lists l JOIN shared_list_members m ON m.list_id=l.id WHERE m.user_id=? AND m.status='member'",
    )
    .all(user)
    .filter((l) => groupAccess(l.id, user).can("host"));
}
export function grantsFor(id: string) {
  return db
    .prepare<[string], { list_id: number; anilist_id: number }>(
      "SELECT list_id,anilist_id FROM desktop_grants WHERE device_id=?",
    )
    .all(id);
}
export function roomHosts(list: number, user: number) {
  groupAccess(list, user);
  const rows = db
    .prepare<[number], Device & { name: string }>(
      `SELECT DISTINCT d.*,u.name FROM desktop_devices d JOIN users u ON u.id=d.user_id JOIN shared_list_members m ON m.user_id=d.user_id WHERE m.list_id=? AND m.status='member' AND d.revoked=0 AND u.blocked=0`,
    )
    .all(list);
  return rows
    .filter((d) => groupAccess(list, d.user_id!).can("host"))
    .map((d) => {
      const allowed = new Set(
        grantsFor(d.id)
          .filter((g) => g.list_id === list)
          .map((g) => g.anilist_id),
      );
      return {
        id: d.id,
        userId: d.user_id,
        name: d.name,
        label: d.label,
        online: d.last_seen > now() - 45,
        lastSeen: d.last_seen,
        files: (JSON.parse(d.inventory) as HostFile[]).filter((f) =>
          allowed.has(f.title),
        ),
      };
    });
}

/** Version 2 includes prepared identity, transport generations and negotiation IDs. */
export function requireDesktopProtocol(req: Request) {
  if (req.headers.get("x-desktop-protocol") !== "2")
    throw new ApiError(426, "Обновите desktop до 0.3.1 или новее: версия транспорта несовместима с сервером. Библиотека и привязка сохранены.");
}

// Stable installation secret proves possession; labels and hostnames are never identity.
export function installationBinding(user: number, key: string, label: string, platform: string, action: string, previousToken?: string) {
  if (!/^[a-f0-9]{64}$/.test(key) || !label?.trim() || label.length > 80 || !["win32","linux"].includes(platform)) throw new ApiError(400,"Некорректное устройство");
  return db.transaction(() => {
    const hash = digest(key);
    let row = db.prepare<[string], Device>("SELECT d.* FROM desktop_devices d JOIN desktop_installations i ON i.device_id=d.id WHERE i.key_hash=?").get(hash);
    if (!row && previousToken && /^[a-f0-9]{64}$/.test(previousToken)) {
      const old = db.prepare<[string],Device>("SELECT * FROM desktop_devices WHERE token_hash=?").get(digest(previousToken));
      if (old && !db.prepare("SELECT 1 FROM desktop_installations WHERE device_id=?").get(old.id)) {
        db.prepare("INSERT INTO desktop_installations(key_hash,device_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(hash,old.id);
        row=db.prepare<[string],Device>("SELECT d.* FROM desktop_devices d JOIN desktop_installations i ON i.device_id=d.id WHERE i.key_hash=?").get(hash);
      }
    }
    if (row) db.prepare("UPDATE desktop_devices SET id=id WHERE id=?").run(row.id);
    if (row) row=db.prepare<[string],Device>("SELECT * FROM desktop_devices WHERE id=?").get(row.id);
    const status = row && !row.revoked && row.user_id ? row.user_id===user?"linked":"other-account" : "unlinked";
    if (action==="status") return {id:row?.id??null,status};
    if (action==="unlink") {
      if(row) revokeDevice(row.id,row.user_id!);
      return {id:row?.id??null,status:"unlinked"};
    }
    if (action!=="link") throw new ApiError(400,"Неизвестное действие");
    if(status==="other-account") throw new ApiError(409,"Сначала отвяжите компьютер от другого аккаунта");
    if(row && status==="linked" && previousToken && row.token_hash===digest(previousToken)) return {id:row.id,status:"linked",alreadyLinked:true};
    const token=randomBytes(32).toString("hex"), id=row?.id??randomBytes(12).toString("hex");
    if(row){
      if(row.revoked || row.user_id!==user){
        db.prepare("DELETE FROM desktop_grants WHERE device_id=?").run(id);
        db.prepare("DELETE FROM desktop_commands WHERE device_id=?").run(id);
        db.prepare("DELETE FROM desktop_download_state WHERE device_id=?").run(id);
      }
      db.prepare("UPDATE desktop_devices SET token_hash=?,user_id=?,label=?,platform=?,revoked=0,last_seen=0,inventory='[]' WHERE id=?").run(digest(token),user,label,platform,id);
    } else {
      db.prepare("INSERT INTO desktop_devices(id,token_hash,user_id,label,platform,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").run(id,digest(token),user,label,platform,now(),now()+600);
      db.prepare("INSERT INTO desktop_installations(key_hash,device_id) VALUES(?,?)").run(hash,id);
    }
    return {id,status:"linked",token};
  })();
}
