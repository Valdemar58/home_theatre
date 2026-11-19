// Manual M7 fixture: isolated loopback server and synthetic media only.
import { Library } from '../src/library.mjs';
import { HostTransport } from '../src/transport.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const server = 'http://127.0.0.1:5058';
const library = new Library(resolve('release/m6-profile/library')); await library.load();
const cache = resolve('release/m7-backup.json'); let pair;
async function api(path, body, token) {
  const r = await fetch(server + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Desktop-Protocol': '2', Origin: server, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const b = await r.json(); if (!r.ok) throw new Error(b.error); return b;
}
try { pair = JSON.parse(await readFile(cache, 'utf8')); } catch {
  pair = await api('/api/desktop/pair', { label: 'M7 backup · synthetic', platform: 'linux' });
  await api('/api/desktop/devices', { action: 'approve', id: pair.id });
  await writeFile(cache, JSON.stringify(pair), { mode: 0o600 });
}
async function beat() { await api('/api/desktop/host', { action: 'heartbeat', files: library.publicFiles() }, pair.token); }
await beat(); await api('/api/desktop/host', { action: 'grant', room: 1, title: 42, enabled: true }, pair.token);
const transport = new HostTransport(library, () => ({ server, token: pair.token })); const read = transport.read.bind(transport);
if (process.env.M7_DELAY) transport.read = async (...args) => { await new Promise(r => setTimeout(r, Number(process.env.M7_DELAY))); return read(...args); };
transport.start();
setInterval(() => void beat().catch(() => {}), 2000);
console.log('Synthetic backup ready:', pair.id);
