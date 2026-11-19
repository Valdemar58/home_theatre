import WebTorrent from "webtorrent";
import parseTorrent from "parse-torrent";

// Metadata discovery must never open paths supplied by an unverified peer.
class MetadataStore {
  constructor() {}
  get(index, options, callback) { (callback || options)(new Error("Metadata only")); }
  put(index, buffer, callback) { callback(new Error("Metadata only")); }
  close(callback) { callback(); }
  destroy(callback) { callback(); }
}

export async function resolveMagnet(uri, { signal, timeout = 90000, clientOptions = {}, onTorrent } = {}) {
  if (typeof uri !== "string" || uri.length > 16384 || !/^magnet:\?/i.test(uri)) throw new Error("Некорректная magnet-ссылка");
  const parsed = await parseTorrent(uri.replace(/^magnet:/i, "magnet:").replace(/%3A/gi, ":"));
  if (!/^[a-f0-9]{40}$/i.test(parsed.infoHash || "")) throw new Error("Нужна magnet-ссылка BitTorrent v1");
  // Strip exact-source / web-seed URLs, selecting files happens only after validation.
  const safe = new URLSearchParams({ xt: `urn:btih:${parsed.infoHash}` });
  for (const tracker of (parsed.announce || []).slice(0, 30)) {
    try { if (["http:", "https:", "udp:", "ws:", "wss:"].includes(new URL(tracker).protocol)) safe.append("tr", tracker); } catch {}
  }
  if (signal?.aborted) throw new Error("Получение списка файлов отменено");
  const client = new WebTorrent({ utp: false, natUpnp: false, natPmp: false, lsd: false, webSeeds: false, maxConns: 15, ...clientOptions });
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, bytes) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(bytes);
      };
      const abort = () => finish(new Error("Получение списка файлов отменено"));
      const timer = setTimeout(() => finish(new Error("Пиры не передали список файлов за 90 секунд. Повторите попытку или выберите другую раздачу.")), timeout);
      signal?.addEventListener("abort", abort, { once: true });
      client.on("error", () => finish(new Error("Не удалось подключиться к пирам. Повторите выбор раздачи.")));
      const torrent = client.add(`magnet:?${safe.toString().replace(/%3A/gi, ":")}`, { deselect: true, store: MetadataStore, storeCacheSlots: 0 });
      torrent.on("error", () => finish(new Error("Не удалось получить список файлов magnet-раздачи.")));
      torrent.once("metadata", () => {
        const bytes = Buffer.from(torrent.torrentFile);
        torrent.destroy();
        finish(bytes.length > 8 * 1024 * 1024 ? new Error("Список файлов раздачи слишком большой") : null, bytes);
      });
      try { onTorrent?.(torrent); } catch (error) { finish(error); }
    });
  } finally { await new Promise(resolve => client.destroy(resolve)); }
}
