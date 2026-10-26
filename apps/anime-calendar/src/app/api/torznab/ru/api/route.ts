import { env } from "@/server/env";
import { cachedSearch, capsXml, rssXml } from "@/server/ru/torznab";

const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "application/xml; charset=utf-8" } });

const error = (code: number, description: string) =>
  xml(`<?xml version="1.0" encoding="UTF-8"?>\n<error code="${code}" description="${description}" />`, code === 100 ? 401 : 400);

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** Torznab API для Sonarr: /api/torznab/ru/api?t=caps|search|tvsearch&apikey=... */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  if (!env.torznabApiKey || p.get("apikey") !== env.torznabApiKey) return error(100, "Неверный API-ключ");

  const t = p.get("t") ?? "search";
  if (t === "caps") return xml(capsXml());
  if (t !== "search" && t !== "tvsearch") return error(202, `Функция ${t} не поддерживается`);
  // Всё отдаём одной страницей
  if (Number(p.get("offset")) > 0) return xml(rssXml([]));

  try {
    const items = await cachedSearch({
      t,
      q: p.get("q") ?? undefined,
      tvdbid: num(p.get("tvdbid")),
      season: num(p.get("season")),
      ep: num(p.get("ep")),
    });
    return xml(rssXml(items));
  } catch (err) {
    console.error("[torznab]", err);
    return error(900, err instanceof Error ? err.message : String(err));
  }
}
