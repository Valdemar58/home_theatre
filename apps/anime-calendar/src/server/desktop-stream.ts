import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { ApiError } from "./route";
import { roomView } from "./rooms";
import { canControl } from "@/lib/room";
import { roomHosts, type HostFile } from "./desktop";

// Ephemeral signaling/relay state follows the existing single-process room coordinator.
// No media is persisted on the server. All requests re-check membership and grants.
export const CHUNK = 1024 * 1024;
type Lease = { id: string; user: number; room: string; device: string; selected: string; generation: number; created: number; file: string; version: string; bytes: number; duration: number; title: number; ep: number; seen: number; offer?: string; negotiation?: string; answer?: string; relayBytes: number; windowAt: number; windowBytes: number };
type Job = { id: string; lease: string; offset: number; length: number; taken: boolean; device?: string; generation?: number; done: (b: Uint8Array) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const global = globalThis as unknown as { __desktopStreams?: { leases: Map<string, Lease>; jobs: Map<string, Job>; hostPolls: Map<string, number> } };
const state: NonNullable<typeof global.__desktopStreams> = global.__desktopStreams ??= { leases: new Map(), jobs: new Map(), hostPolls: new Map() };
const hostPolls = state.hostPolls ??= new Map<string, number>();
const HOST_TIMEOUT = 5000;
const id = () => randomBytes(16).toString("hex");
function personalFile(user: number, device: string, title: number, ep: number) {
  const d = db.prepare<[string, number], { inventory: string }>("SELECT inventory FROM desktop_devices WHERE id=? AND user_id=? AND revoked=0").get(device, user);
  const f = d && (JSON.parse(d.inventory) as HostFile[]).find(f => f.title === title && f.ep === ep && f.state === "ready" && f.preparedVersion && f.preparedBytes && f.duration);
  if (!f) throw new ApiError(403, "На вашем устройстве нет готовой копии этой серии или доступ отозван");
  return f;
}
function joined(user: number, room: string) {
  const r = roomView(user, room);
  if (!r.groupId || r.ended || r.members.find(m => m.id === user)?.status !== "joined") throw new ApiError(403, "Сначала войдите в просмотр комнаты");
  return r;
}
export function sourceState(user: number, room: string) {
  const r = joined(user, room);
  const selected = db.prepare<[string], { device_id: string | null }>("SELECT device_id FROM desktop_room_sources WHERE room_id=?").get(room)?.device_id ?? null;
  const active = [...state.leases.values()].find(l => l.room === room && l.title === r.anilistId && l.ep === r.state.ep)?.device ?? selected;
  return { selected, active, hosts: roomHosts(r.groupId!, user).map(h => ({ ...h, online: h.online && Date.now() - (hostPolls.get(h.id) ?? 0) < HOST_TIMEOUT, files: h.files.filter(f => f.title === r.anilistId && f.state === "ready" && f.preparedVersion) })) };
}
export function selectSource(user: number, room: string, device: string | null) {
  const r = joined(user, room);
  if (!canControl(r.preset, r.members.find(m => m.id === user))) throw new ApiError(403, "Нет права управлять просмотром");
  if (device && !sourceState(user, room).hosts.some(h => h.id === device && h.online && h.files.some(f => f.ep === r.state.ep))) throw new ApiError(409, "На хосте нет готовой разрешённой серии");
  db.prepare("INSERT INTO desktop_room_sources(room_id,device_id) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET device_id=excluded.device_id").run(room, device);
  for (const l of state.leases.values()) if (l.room === room && l.selected !== device) closeLease(l.id, l.user);
}
function check(l: Lease) {
  if (Date.now() - l.seen > 90000) throw new ApiError(410, "Подключение к хосту истекло");
  if (l.room.startsWith("device:")) {
    const f = personalFile(l.user, l.device, l.title, l.ep);
    if (f.id !== l.file || f.preparedVersion !== l.version || f.preparedBytes !== l.bytes) throw new ApiError(409, "Локальный файл изменился");
    return l;
  }
  const r = joined(l.user, l.room);
  const source = sourceState(l.user, l.room);
  if (source.selected !== l.selected || r.anilistId !== l.title || r.state.ep !== l.ep) throw new ApiError(409, "Источник или серия комнаты изменились");
  const matches = (f: (typeof source.hosts)[number]["files"][number]) => f.ep === l.ep && f.preparedVersion === l.version && f.preparedBytes === l.bytes;
  const host = source.hosts.find(h => h.id === l.device);
  // Revoked grants and changed files must never remain authorized, even during recovery.
  if (!host?.files.some(matches)) throw new ApiError(409, "Файл изменён или доступ отозван");
  const live = (device: string) => Date.now() - (hostPolls.get(device) ?? 0) < HOST_TIMEOUT;
  if (process.env.DESKTOP_HANDOVER_ENABLED !== "0" && (!host.online || (!live(l.device) && Date.now() - l.created > HOST_TIMEOUT))) {
    const backup = source.hosts.filter(h => h.id !== l.device && h.online && live(h.id) && h.files.some(matches))
      .filter(h => [...state.leases.values()].filter(x => x.device === h.id || (x.room === l.room && x.version === l.version && x.ep === l.ep)).length <= 8)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (backup) {
      // One synchronous coordinator decision retargets every viewer without changing
      // their media URL or room clock. Buffered MP4 bytes remain valid by SHA-256.
      for (const other of state.leases.values()) if (other.room === l.room && other.selected === l.selected && other.title === l.title && other.ep === l.ep && other.version === l.version && other.bytes === l.bytes) {
        other.device = backup.id; other.file = backup.files.find(matches)!.id;
        other.generation++; other.offer = undefined; other.negotiation = undefined; other.answer = undefined;
        for (const j of state.jobs.values()) if (j.lease === other.id) { j.taken = false; j.device = undefined; j.generation = undefined; }
      }
    }
  }
  return l;
}
export function leaseFor(key: string, user: number) {
  const l = state.leases.get(key);
  if (!l || l.user !== user) throw new ApiError(404, "Подключение к хосту не найдено");
  return check(l);
}
export function openLease(user: number, room: string, title: number, ep: number) {
  for (const l of state.leases.values()) if (Date.now() - l.seen > 90000) closeLease(l.id, l.user);
  if (room.startsWith("device:")) {
    const device = room.slice(7), f = personalFile(user, device, title, ep);
    if (Date.now() - (hostPolls.get(device) ?? 0) >= HOST_TIMEOUT) throw new ApiError(409, "Домашний компьютер не подключён. Откройте на нём приложение.");
    if (state.leases.size >= 64 || [...state.leases.values()].filter(l => l.device === device).length >= 8) throw new ApiError(429, "Лимит подключений к устройству");
    const l: Lease = { id: id(), user, room, device, selected: device, generation: 1, created: Date.now(), file: f.id, version: f.preparedVersion!, bytes: f.preparedBytes!, duration: f.duration!, title, ep, seen: Date.now(), relayBytes: 0, windowAt: Date.now(), windowBytes: 0 };
    state.leases.set(l.id, l); return l;
  }
  const r = joined(user, room), source = sourceState(user, room);
  if (r.anilistId !== title || r.state.ep !== ep) throw new ApiError(409, "Серия комнаты уже изменилась");
  const preferred = source.hosts.find(h => h.id === source.selected);
  const reference = preferred?.files.find(f => f.ep === ep && f.preparedBytes && f.duration && f.preparedVersion);
  const same = (h: (typeof source.hosts)[number]) => h.files.some(f => f.ep === ep && f.preparedVersion === reference?.preparedVersion && f.preparedBytes === reference?.preparedBytes);
  const active = source.hosts.find(h => h.id === source.active && h.online && same(h));
  const h = active && (Date.now() - (hostPolls.get(active.id) ?? Date.now()) < HOST_TIMEOUT) ? active
    : process.env.DESKTOP_HANDOVER_ENABLED === "0" ? undefined : source.hosts.find(h => h.online && same(h) && Date.now() - (hostPolls.get(h.id) ?? 0) < HOST_TIMEOUT);
  const f = h?.files.find(f => f.ep === ep && f.preparedVersion === reference?.preparedVersion && f.preparedBytes === reference?.preparedBytes);
  if (!h || !f) throw new ApiError(409, "Выбранный хост не готов. Подготовьте серию на устройстве или выберите другой источник");
  if ([...state.leases.values()].filter(l => l.device === h.id).length >= 8 || state.leases.size >= 64) throw new ApiError(429, "Лимит подключений к хосту");
  const l: Lease = { id: id(), user, room, device: h.id, selected: source.selected!, generation: 1, created: Date.now(), file: f.id, version: f.preparedVersion!, bytes: f.preparedBytes!, duration: f.duration!, title, ep, seen: Date.now(), relayBytes: 0, windowAt: Date.now(), windowBytes: 0 };
  state.leases.set(l.id, l);
  return l;
}
export function closeLease(key: string, user: number) {
  const l = state.leases.get(key);
  if (!l || l.user !== user) return;
  state.leases.delete(key);
  for (const j of state.jobs.values()) if (j.lease === key) j.fail(new ApiError(410, "Поток закрыт"));
}
export function viewerSignal(key: string, user: number, offer?: string, generation = 1) {
  const l = leaseFor(key, user);
  l.seen = Date.now();
  if (offer !== undefined) {
    if (generation !== l.generation) throw new ApiError(409, "Версия соединения изменилась");
    if (typeof offer !== "string" || offer.length > 32000 || !offer.startsWith("v=0")) throw new ApiError(400, "Некорректное предложение связи");
    if (l.offer !== offer) { l.offer = offer; l.negotiation = id(); l.answer = undefined; }
  }
  return { device: l.device, generation: l.generation, recovering: Date.now() - (hostPolls.get(l.device) ?? l.created) >= HOST_TIMEOUT, answer: l.answer, bytes: l.bytes, relayBytes: l.relayBytes, iceServers: iceServers() };
}
function iceServers() {
  // Administrator-provided STUN; no hidden third-party endpoint or static TURN secrets.
  const urls = (process.env.DESKTOP_STUN_URLS || "").split(",").map(s => s.trim()).filter(s => /^stuns?:[^\s]+$/.test(s));
  return urls.length ? [{ urls }] : [];
}
export function hostState(device: string) {
  hostPolls.set(device, Date.now());
  // Keep the liveness map bounded by the current inventory, not historical devices.
  for (const [key, seen] of hostPolls) if (Date.now() - seen > 90000) hostPolls.delete(key);
  const streams: { id: string; generation: number; file: string; version: string; bytes: number; offer?: string; negotiation?: string; iceServers: { urls: string[] }[] }[] = [];
  for (const l of state.leases.values()) if (l.device === device) {
    try { check(l); if (l.device !== device) continue; streams.push({ id: l.id, generation: l.generation, file: l.file, version: l.version, bytes: l.bytes, offer: l.offer, negotiation: l.negotiation, iceServers: iceServers() }); }
    catch { closeLease(l.id, l.user); }
  }
  const jobs = [...state.jobs.values()].filter(j => !j.taken && streams.some(l => l.id === j.lease)).slice(0, 8);
  for (const j of jobs) { j.taken = true; j.device = device; j.generation = state.leases.get(j.lease)!.generation; }
  return { streams, jobs: jobs.map(({ id, lease, offset, length, generation }) => ({ id, lease, offset, length, generation })) };
}
export function hostAnswer(device: string, key: string, answer: string, generation = 1, negotiation?: string) {
  const l = state.leases.get(key);
  if (!l || l.device !== device) throw new ApiError(404, "Поток закрыт");
  check(l);
  if (l.device !== device || l.generation !== generation || !l.negotiation || negotiation !== l.negotiation) throw new ApiError(409, "Соединение уже заменено");
  if (typeof answer !== "string" || answer.length > 32000 || !answer.startsWith("v=0")) throw new ApiError(400, "Некорректный ответ связи");
  l.answer = answer;
}
export function relayChunk(l: Lease, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  check(l);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > CHUNK || offset + length > l.bytes) throw new ApiError(416, "Некорректный диапазон");
  if (process.env.DESKTOP_RELAY_ENABLED === "0") throw new ApiError(503, "Ретрансляция отключена администратором");
  if (state.jobs.size >= 32 || [...state.jobs.values()].filter(j => j.lease === l.id).length >= 4) throw new ApiError(429, "Ретранслятор занят");
  if (Date.now() - l.windowAt > 60000) { l.windowAt = Date.now(); l.windowBytes = 0; }
  if (l.windowBytes + length > 256 * CHUNK) throw new ApiError(429, "Лимит ретрансляции: 256 МиБ в минуту на зрителя");
  l.windowBytes += length;
  return new Promise((resolve, reject) => {
    const key = id();
    const cleanup = () => { const j = state.jobs.get(key); if (j) clearTimeout(j.timer); state.jobs.delete(key); signal?.removeEventListener("abort", abort); };
    const fail = (e: Error) => { cleanup(); reject(e); };
    const abort = () => fail(new ApiError(499, "Запрос отменён"));
    state.jobs.set(key, { id: key, lease: l.id, offset, length, taken: false, timer: setTimeout(() => fail(new ApiError(504, "Хост не ответил за 15 секунд")), 15000), fail, done: b => { cleanup(); l.relayBytes += b.length; resolve(b); } });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export function fulfill(device: string, key: string, body: Uint8Array, error?: string, generation = 1) {
  const j = state.jobs.get(key), l = j && state.leases.get(j.lease);
  if (!j || !l || l.device !== device || j.device !== device || j.generation !== generation || l.generation !== generation) throw new ApiError(404, "Запрос уже завершён");
  try { check(l); } catch (e) { j.fail(e as Error); throw e; }
  if (l.device !== device || l.generation !== generation) throw new ApiError(409, "Хост уже заменён");
  if (error || body.length !== j.length) { j.fail(new ApiError(502, error || "Неполный ответ хоста")); return; }
  j.done(body);
}
export function parseRange(value: string | null, bytes: number): [number, number] {
  if (!value) return [0, bytes - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw new ApiError(416, "Поддерживается один диапазон байтов");
  const start = m[1] ? Number(m[1]) : Math.max(0, bytes - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(bytes - 1, Number(m[2])) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes) throw new ApiError(416, "Диапазон за пределами файла");
  return [start, end];
}
