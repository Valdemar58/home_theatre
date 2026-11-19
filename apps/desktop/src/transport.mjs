import { open, stat } from "node:fs/promises";
const MAX = 1024 * 1024;
export async function readMedia(library, stream, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > MAX || offset + length > stream.bytes) throw new Error("Некорректный диапазон");
  const f = library.files.find(f => f.id === stream.file && f.state === "ready" && f.preparedVersion === stream.version && f.preparedBytes === stream.bytes);
  if (!f) throw new Error("Подготовленный файл недоступен");
  const s = await stat(f.path), output = await stat(f.output);
  if (s.size !== f.bytes || s.mtimeMs !== f.mtime || output.size !== f.preparedBytes || output.mtimeMs !== f.preparedMtime) throw new Error("Файл изменён. Подготовьте серию заново");
  const fd = await open(f.output, "r");
  try {
    const buffer = Buffer.alloc(length); const { bytesRead } = await fd.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error("Неполное чтение файла");
    return buffer;
  } finally { await fd.close(); }
}
export class HostTransport {
  constructor(library, credentials) { this.library = library; this.credentials = credentials; this.streams = []; this.seen = 0; this.busy = false; this.stopped = false; }
  async request(path, options = {}) {
    const { server, token } = this.credentials();
    if (!server || !token) throw new Error("Устройство не привязано");
    const r = await fetch(server + "/api/desktop/transport" + path, { ...options, headers: { ...options.headers, "X-Desktop-Protocol": "2", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `Транспорт: ${r.status}`); }
    if (this.credentials().token !== token) throw new Error("Привязка изменена");
    return r.json();
  }
  async poll() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const r = await this.request(""); this.error = ""; this.streams = r.streams; this.seen = Date.now();
      void Promise.all(r.jobs.map(async job => {
        let body, failed = false;
        try { body = await this.read(job.lease, job.offset, job.length); } catch { body = new Uint8Array(); failed = true; }
        await this.request(`?job=${job.id}&generation=${job.generation ?? 1}`, { method: "POST", body, headers: failed ? { "X-Host-Error": "1" } : {} }).catch(() => {});
      }));
    } catch (e) { this.error = e.message; this.streams = []; this.seen = 0; }
    finally { this.busy = false; }
  }
  list() { return Date.now() - this.seen < 3000 ? this.streams : []; }
  read(id, offset, length) {
    const s = this.list().find(s => s.id === id);
    if (!s) throw new Error("Разрешение потока истекло");
    return readMedia(this.library, s, offset, length);
  }
  answer(id, answer, generation, negotiation) {
    if (!this.list().some(s => s.id === id)) throw new Error("Поток закрыт");
    return this.request("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lease: id, answer, generation, negotiation }) });
  }
  start() { this.timer = setInterval(() => void this.poll(), 250); this.timer.unref(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.streams = []; }
}
