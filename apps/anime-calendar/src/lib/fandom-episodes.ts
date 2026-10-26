import { htmlText } from "./wiki-episodes";

// Fandom: у каждой вики своя разметка, общего мало — категория серий, инфобокс серии (дата, сезон)
// и разделы сюжета на странице серии. Здесь — чистый разбор этих кусков.

/** Категория со страницами серий: «Episodes» / «Anime episodes», без «Episode 5 images» и арок. */
export function episodeCategory(categories: string[]): string | null {
  const c = categories.filter((x) => /episodes?$/i.test(x.trim()) && !/images?|mini|arc|chapter|manga|dub|ova|special/i.test(x));
  const exact = c.find((x) => /^(anime )?episodes$/i.test(x.trim()));
  return exact ?? c.sort((a, b) => a.length - b.length)[0] ?? null;
}

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";

/** Первая дата в строке: «October 2, 2018», «2 October 2018», «2020-12-05», {{Start date|2018|10|2}}. */
export function parseDate(s: string): string | null {
  const tpl = s.match(/\{\{\s*(?:start date|dts|date)[^|]*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
  if (tpl) return `${tpl[1]}-${tpl[2].padStart(2, "0")}-${tpl[3].padStart(2, "0")}`;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const m = s.match(new RegExp(`(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})|(\\d{1,2})\\s+(${MONTHS})\\.?,?\\s+(\\d{4})`, "i"));
  if (!m) return null;
  const [month, day, year] = m[1] ? [m[1], m[2], m[3]] : [m[5], m[4], m[6]];
  const n = MONTHS.split("|").indexOf(month.toLowerCase()) + 1;
  return `${year}-${String(n).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Поля инфобокса из wikitext: «|Имя = значение» до следующего «|» в начале строки. */
function infoboxFields(wikitext: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const m of wikitext.matchAll(/^\s*\|\s*([^=|\n]+?)\s*=\s*(.*)$/gm)) {
    const key = m[1].toLowerCase().replace(/_/g, " ").trim();
    if (!fields.has(key)) fields.set(key, m[2].trim());
  }
  return fields;
}

export type FandomInfo = { date: string | null; season: string | null; number: string | null };

/**
 * Дата японского показа и сезон серии по инфобоксу. Дата — первая в поле, кроме предпоказов,
 * режиссёрских версий и повторов («Early Screening», «Director's Cut»); английский показ не берём.
 */
export function infoboxInfo(wikitext: string): FandomInfo {
  const f = infoboxFields(wikitext);
  const keys = [...f.keys()].filter((k) => /air ?date/.test(k) && !/english|^us |dub|^en /.test(k));
  const key = keys.find((k) => /jp|japan/.test(k)) ?? keys[0];
  let date: string | null = null;
  if (key) {
    for (const part of f.get(key)!.split(/<br\s*\/?>|\n/i)) {
      if (/early|screening|preview|director|re-?air|rebroadcast|english|dub/i.test(part)) continue;
      date = parseDate(part);
      if (date) break;
    }
  }
  const clean = (v: string | undefined) => v?.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\{\{[^}]*\}\}|<[^>]+>/g, "").trim() || null;
  return { date, season: clean(f.get("season") ?? f.get("season number")), number: clean(f.get("episode") ?? f.get("ep number") ?? f.get("number")) };
}

const PLOT = /^(summary|plot|plot details|plot summary|story|recap|full summary)$/i;
const SHORT = /^(synopsis|overview|brief)$/i;

/** Разделы страницы серии: короткий анонс и подробный пересказ (самый длинный из «Summary / Plot / …»). */
export function plotSections(html: string): { synopsis: string | null; plot: string | null } {
  const parts = html.split(/(?=<h2\b)/);
  let synopsis: string | null = null;
  let plot: string | null = null;
  for (const p of parts) {
    const id = p.match(/^<h2[^>]*>.*?<span[^>]*class="mw-headline"[^>]*id="([^"]+)"/s)?.[1];
    if (!id) continue;
    const name = id.replace(/_/g, " ").replace(/\.\d\d/g, "");
    const body = htmlText(p.replace(/^<h2[^>]*>.*?<\/h2>/s, "").replace(/<figure.*?<\/figure>|<div[^>]*class="[^"]*(?:thumb|gallery|navbox|toc)[^"]*".*?<\/div>/gs, ""));
    if (SHORT.test(name) && !synopsis) synopsis = body || null;
    else if (PLOT.test(name) && body.length > (plot?.length ?? 0)) plot = body;
  }
  return { synopsis, plot };
}
