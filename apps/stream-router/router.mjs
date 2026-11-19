// Маршрутизатор потоков «Стрима» (TASKS 9.8): Jellyfin берёт серии по ссылкам из .strm —
// http://torrserver:8090/stream/<файл>?link=<хэш>&index=<номер>&play — и запоминает их навсегда (.strm он больше
// не перечитывает). Имя torrserver в docker-сети — у этого маршрутизатора: серию, которую календарь заранее скачал
// через qBittorrent («Подготовить»), он отдаёт с диска, остальное — передаёт в настоящий TorrServer (torrserver-core).
// Какие серии скачаны — /stream/.prep/index.json: {"<хэш>:<номер>": "<путь от /stream/.prep>"}, пишет календарь.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = 8090;
const CORE = new URL(process.env.TORRSERVER_CORE ?? "http://torrserver-core:8090");
const PREP = process.env.PREP_DIR ?? "/stream/.prep";
const INDEX = path.join(PREP, "index.json");

let index = {};
let indexMtime = 0;
function prepared(hash, idx) {
  try {
    const st = fs.statSync(INDEX);
    if (st.mtimeMs !== indexMtime) {
      index = JSON.parse(fs.readFileSync(INDEX, "utf-8"));
      indexMtime = st.mtimeMs;
    }
  } catch {
    index = {};
    indexMtime = 0;
  }
  const rel = index[`${hash}:${idx}`];
  if (!rel) return null;
  const file = path.resolve(PREP, rel);
  if (!file.startsWith(path.resolve(PREP) + path.sep)) return null;
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { file, size: st.size } : null;
  } catch {
    return null;
  }
}

const TYPES = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo", ".ts": "video/mp2t" };

/** Файл с диска с поддержкой Range (перемотка в Jellyfin/ffmpeg). */
function serveFile(req, res, { file, size }) {
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(m[2])); }
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "X-Served-By": "prepared" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Всё остальное — в TorrServer как есть (заголовки, Range, тело). */
function proxy(req, res) {
  const up = http.request({
    host: CORE.hostname, port: CORE.port || 80, method: req.method, path: req.url,
    headers: { ...req.headers, host: CORE.host },
  }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`TorrServer недоступен: ${e.message}`);
  });
  res.on("close", () => up.destroy());
  req.pipe(up);
}

http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if ((req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/stream/")) {
    const hash = (u.searchParams.get("link") ?? "").toLowerCase();
    const idx = u.searchParams.get("index");
    const p = /^[0-9a-f]{40}$/.test(hash) && idx ? prepared(hash, idx) : null;
    if (p) return serveFile(req, res, p);
  }
  proxy(req, res);
}).listen(PORT, () => console.log(`маршрутизатор потоков: :${PORT} → ${CORE.host}, подготовленные — ${PREP}`));
