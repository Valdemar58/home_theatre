import "server-only";
import { randomUUID } from "node:crypto";
import { db, now } from "./db";
import { ApiError } from "./route";
import { hostRooms, grantsFor } from "./desktop";
import { downloadContext } from "./download-context";

type Command = { id: string; device_id: string; kind: string; payload: string; state: string; result: string; created_at: number };
export function ownedDevice(user: number, device: string) {
  const d = db.prepare<[string, number], { id: string }>("SELECT id FROM desktop_devices WHERE id=? AND user_id=? AND revoked=0").get(device, user);
  if (!d) throw new ApiError(404, "Устройство не найдено или доступ отозван");
  return d;
}
export function enqueue(user: number, device: string, kind: string, payload: unknown) {
  ownedDevice(user, device);
  const count = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM desktop_commands WHERE device_id=? AND state='queued'").get(device)!.n;
  if (count >= 30) throw new ApiError(429, "В очереди уже 30 действий. Дождитесь подключения устройства.");
  const id = randomUUID();
  const previous = db.prepare<[string], { latest: number | null }>("SELECT MAX(created_at) AS latest FROM desktop_commands WHERE device_id=?").get(device)?.latest ?? 0;
  db.prepare("INSERT INTO desktop_commands(id,device_id,kind,payload,created_at) VALUES(?,?,?,?,?)").run(id, device, kind, JSON.stringify(payload), Math.max(Date.now(), Number(previous) + 1));
  return { id };
}
export function pendingCommands(device: string) {
  return db.prepare<[string], Command>("SELECT * FROM desktop_commands WHERE device_id=? AND state='queued' ORDER BY created_at,id LIMIT 1").all(device).map(c => ({ id: c.id, kind: c.kind, payload: JSON.parse(c.payload) }));
}
export function finishCommand(device: string, id: string, result: unknown, error?: string) {
  const text = JSON.stringify(error ? { error: error.slice(0, 1000) } : result);
  if (text.length > 500000) throw new ApiError(413, "Слишком большой результат");
  db.prepare("UPDATE desktop_commands SET state=?,result=?,payload='{}' WHERE id=? AND device_id=? AND state='queued'").run(error ? "error" : "done", text, id, device);
  db.prepare("DELETE FROM desktop_commands WHERE device_id=? AND state<>'queued' AND created_at<?").run(device, Date.now() - 7 * 86400000);
}
export function reportDownloads(device: string, snapshot: unknown, extra?: {storage?:unknown;library?:unknown;capabilities?:unknown}) {
  if (!Array.isArray(snapshot) || snapshot.length > 100 || JSON.stringify(snapshot).length > 2000000) throw new ApiError(413, "Слишком большая очередь");
  // Дата команды создания сохраняется в сводке: очистка очереди команд её не потеряет.
  // Для старых загрузок без истории не подставляем дату очередного heartbeat.
  const previous=db.prepare<[string],{snapshot:string}>("SELECT snapshot FROM desktop_download_state WHERE device_id=?").get(device);
  const old=JSON.parse(previous?.snapshot||"[]");
  const dates=new Map<string,number>();
  for(const job of Array.isArray(old)?old:old.jobs??[])if(job?.id&&Number.isFinite(job.createdAt))dates.set(job.id,job.createdAt);
  for(const command of db.prepare<[string],Command>("SELECT result,created_at FROM desktop_commands WHERE device_id=? AND kind='inspect' AND state='done' ORDER BY created_at").all(device)) {
    const result=JSON.parse(command.result);
    if(typeof result.job==="string"&&!dates.has(result.job))dates.set(result.job,Math.floor(command.created_at/1000));
  }
  const jobs=snapshot.map(job=>job&&typeof job==="object"&&typeof job.id==="string"&&dates.has(job.id)?{...job,createdAt:dates.get(job.id)}:job);
  const value=extra ? {jobs,storage:extra.storage,library:Array.isArray(extra.library)?extra.library:[],capabilities:Array.isArray(extra.capabilities)?extra.capabilities:[]} : jobs;
  if(JSON.stringify(value).length>2400000)throw new ApiError(413,"Слишком большая сводка устройства");
  db.prepare("INSERT INTO desktop_download_state(device_id,snapshot,updated_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at").run(device, JSON.stringify(value), now());
}
export function deviceDownloads(user: number, device: string) {
  ownedDevice(user, device);
  const snapshot = db.prepare<[string], { snapshot: string; updated_at: number }>("SELECT snapshot,updated_at FROM desktop_download_state WHERE device_id=?").get(device);
  const value=JSON.parse(snapshot?.snapshot || "[]");
  const jobs=Array.isArray(value)?value:value.jobs??[], library=Array.isArray(value)?[]:value.library??[];
  const titles=[...new Set<number>([...jobs,...library].map((j:{title:number})=>j.title).filter((id:number)=>Number.isSafeInteger(id)&&id>0))];
  return { jobs, storage:Array.isArray(value)?null:value.storage,library,capabilities:Array.isArray(value)?[]:value.capabilities,context:downloadContext(user,titles), updatedAt: snapshot?.updated_at ?? null, rooms: hostRooms(user), grants: grantsFor(device),
    commands: db.prepare<[string], Command>("SELECT id,kind,state,result,created_at FROM desktop_commands WHERE device_id=? ORDER BY created_at DESC,id DESC LIMIT 100").all(device).map(c => ({ id: c.id, kind: c.kind, state: c.state, result: JSON.parse(c.result) })) };
}
