import "server-only";
import { createHash } from "node:crypto";
import { searchOrig, searchRu, type ProwlarrRelease } from "./ru/arr";
import { env } from "./env";
import { ApiError } from "./route";

// Device-scoped handles, never expose Prowlarr URLs/API keys to the client.
const entries = new Map<string, { device: string; release: ProwlarrRelease; expires: number }>();
export async function desktopReleases(device: string, query: string) {
  if (query.trim().length < 2 || query.length > 150) throw new ApiError(400, "Введите название раздачи (2–150 символов)");
  if (!env.prowlarrUrl || !env.prowlarrApiKey) throw new ApiError(503, "Поиск раздач не подключён. Добавьте torrent-файл или magnet-ссылку на устройство.");
  const results = await Promise.allSettled([searchRu(query.trim()), searchOrig(query.trim(), true)]);
  if (results.every(r => r.status === "rejected")) throw new ApiError(502, "Индексаторы недоступны. Проверьте серверные подключения и повторите поиск.");
  for (const [id, e] of entries) if (e.expires < Date.now()) entries.delete(id);
  const releases = [...new Map(results.flatMap(r => r.status === "fulfilled" ? r.value : []).map(r => [r.guid, r])).values()]
    .filter(r => r.downloadUrl || r.magnetUrl).sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)).slice(0, 100).map(r => {
      const id = createHash("sha256").update(`${device}\0${r.guid}`).digest("hex");
      entries.set(id, { device, release: r, expires: Date.now() + 30 * 60_000 });
      return { id, title: r.title, size: r.size, seeders: r.seeders ?? 0, indexer: r.indexer };
    });
  while (entries.size > 2000) entries.delete(entries.keys().next().value!);
  return { releases, warning: results.some(r => r.status === "rejected") ? "Часть индексаторов недоступна. Показаны доступные результаты." : null };
}

export async function desktopTorrent(device: string, id: string) {
  const entry = entries.get(id);
  if (!entry || entry.device !== device || entry.expires < Date.now()) throw new ApiError(404, "Результат поиска устарел. Найдите раздачу ещё раз.");
  const magnetResult = (value: string) => {
    if (value.length > 16384 || !/^magnet:\?/i.test(value)) throw new ApiError(400, "Некорректная magnet-ссылка");
    const params = new URL(value).searchParams;
    const hash = params.getAll("xt").find(v => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(v));
    if (!hash) throw new ApiError(400, "Magnet должен содержать BitTorrent v1 info-hash");
    const safe = new URLSearchParams({ xt: hash });
    if (params.get("dn")) safe.set("dn", params.get("dn")!.slice(0, 500));
    for (const tracker of params.getAll("tr").slice(0, 30)) {
      try { if (["http:", "https:", "udp:", "ws:", "wss:"].includes(new URL(tracker).protocol)) safe.append("tr", tracker); } catch { /* ignore invalid tracker */ }
    }
    return { magnet: `magnet:?${safe.toString().replace(/%3A/gi, ":")}`, title: entry.release.title };
  };
  const source = entry.release.downloadUrl || entry.release.magnetUrl!;
  if (/^magnet:/i.test(source)) return magnetResult(source);
  const url = new URL(source);
  if (url.origin !== new URL(env.prowlarrUrl).origin) throw new ApiError(400, "Индексатор не предоставил серверную ссылку на torrent-файл");
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000) });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "";
    await res.body?.cancel();
    if (/^magnet:/i.test(location)) return magnetResult(location);
    if (entry.release.magnetUrl) return magnetResult(entry.release.magnetUrl);
    throw new ApiError(502, "Индексатор перенаправил запрос без torrent-файла или magnet-ссылки");
  }
  if (!res.ok) throw new ApiError(502, "Не удалось получить torrent-файл. Повторите выбор раздачи.");
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(502, "Пустой ответ индексатора");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) throw new ApiError(413, "Torrent-файл слишком большой"); parts.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(parts);
  if (bytes.subarray(0, 8).toString().toLowerCase() === "magnet:?") return magnetResult(bytes.toString().trim());
  return { torrent: bytes.toString("base64"), title: entry.release.title };
}
