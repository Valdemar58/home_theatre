// Manual synthetic integration fixture. Never configure the production server with this indexer.
import { createServer } from "node:http";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import WebTorrent from "webtorrent";
const root = resolve("release/download-fixture"); await mkdir(root, { recursive: true });
const files = [];
for (const n of [1, 2, 3]) { const file = join(root, `Synthetic S01E0${n}.mp4`); await copyFile(resolve("release/m6-sample.mp4"), file); files.push(file); }
const client = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false });
if (process.env.FIXTURE_UPLOAD_LIMIT) client.throttleUpload(Number(process.env.FIXTURE_UPLOAD_LIMIT));
client.on("error", e => console.error(e.message));
const torrent = await new Promise(resolve => client.seed(files, { name: process.env.FIXTURE_NAME || (process.env.FIXTURE_MAGNET ? "Synthetic magnet season" : "Synthetic season"), announce: ["http://127.0.0.1:5062/announce"] }, resolve));
await writeFile(join(root, "fixture.torrent"), torrent.torrentFile);
const peer = Buffer.alloc(6); peer.set([127, 0, 0, 1]); peer.writeUInt16BE(client.torrentPort, 4);
createServer((req, res) => {
  if (req.url.startsWith("/announce")) { res.end(Buffer.concat([Buffer.from("d8:intervali5e5:peers6:"), peer, Buffer.from("e")])); return; }
  if (req.url === "/download") { res.setHeader("Content-Type", "application/x-bittorrent"); res.end(Buffer.from(torrent.torrentFile)); return; }
  res.setHeader("Content-Type", "application/json");
  const result = req.url.startsWith("/api/v1/indexer") ? [{ id: 1, name: "Synthetic local tracker", enable: true, tags: [1], language: "ru" }]
    : req.url.startsWith("/api/v1/tag") ? [{ id: 1, label: "ru" }]
    : req.url.startsWith("/api/v1/search") ? [{ guid: "synthetic-batch", title: "Synthetic season · 3 серии · локальный тест", size: torrent.length, seeders: 1, indexer: "Synthetic local tracker", indexerId: 1, downloadUrl: "http://host.docker.internal:5062/download", categories: [{ id: 5070 }], publishDate: new Date().toISOString() }] : [];
  if (process.env.FIXTURE_MAGNET && req.url.startsWith("/api/v1/search")) for (const release of result) { delete release.downloadUrl; release.magnetUrl = torrent.magnetURI; release.guid = "synthetic-magnet"; release.title = "Synthetic magnet · 3 серии"; }
  res.end(JSON.stringify(result));
}).listen(5062, "0.0.0.0", () => console.log("Synthetic indexer/tracker ready: 5062"));
