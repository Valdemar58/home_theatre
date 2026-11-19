// .torrent для qBittorrent («Подготовить серию» — скачать её целиком, TASKS 9.8). Раздачи «Стрима» добавлялись в
// TorrServer, сам файл .torrent не сохранялся — но TorrServer хранит в своей базе (bbolt, записи JSON) описание
// раздачи: InfoBytes — словарь info как есть (его SHA-1 и есть хэш раздачи) и трекеры. Из них .torrent собирается заново.

export type TorrentSpec = { infoHash: string; infoBytes: Uint8Array; trackers: string[][] };

const enc = new TextEncoder();
const bstr = (s: string | Uint8Array) => {
  const b = typeof s === "string" ? enc.encode(s) : s;
  return concat([enc.encode(`${b.length}:`), b]);
};
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/** .torrent: announce (первый трекер), announce-list (все уровни), info — байты как в исходной раздаче. */
export function torrentFile(spec: Pick<TorrentSpec, "infoBytes" | "trackers">): Uint8Array {
  const tiers = spec.trackers.map((t) => t.filter(Boolean)).filter((t) => t.length);
  const parts: Uint8Array[] = [enc.encode("d")];
  // Ключи словаря — по порядку байтов: announce < announce-list < info
  if (tiers.length) {
    parts.push(bstr("announce"), bstr(tiers[0][0]));
    parts.push(bstr("announce-list"), enc.encode("l"), ...tiers.map((t) => concat([enc.encode("l"), ...t.map(bstr), enc.encode("e")])), enc.encode("e"));
  }
  parts.push(bstr("info"), spec.infoBytes, enc.encode("e"));
  return concat(parts);
}

/**
 * Описания раздач из сырого файла базы TorrServer: JSON-записи {"Trackers": …, "InfoBytes": base64, "InfoHash": …}.
 * Одна раздача встречается несколько раз (старые страницы bbolt) — проверку SHA-1 и выбор делает вызывающий.
 */
export function specsFromTorrServerDb(raw: Uint8Array): TorrentSpec[] {
  const text = new TextDecoder("latin1").decode(raw);
  const out: TorrentSpec[] = [];
  for (let at = text.indexOf('{"Trackers"'); at >= 0; at = text.indexOf('{"Trackers"', at + 1)) {
    const end = jsonEnd(text, at);
    if (end < 0) continue;
    try {
      const o = JSON.parse(text.slice(at, end)) as { Trackers?: string[][] | null; InfoBytes?: string; InfoHash?: string };
      if (!o.InfoBytes || !o.InfoHash) continue;
      out.push({ infoHash: o.InfoHash.toLowerCase(), infoBytes: Uint8Array.from(atob(o.InfoBytes), (c) => c.charCodeAt(0)), trackers: o.Trackers ?? [] });
    } catch {
      // запись порвана страницей — дальше
    }
  }
  return out;
}

/** Конец JSON-объекта с позиции start (с учётом строк и экранирования), -1 — не закрыт. */
function jsonEnd(s: string, start: number): number {
  let depth = 0, str = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === "\\") i++;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}
