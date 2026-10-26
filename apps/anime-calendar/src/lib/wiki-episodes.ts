// Пересказы серий из HTML Википедии (шаблон Episode list: строка серии + строка с описанием)
// и выбор серий тайтла AniList по датам выхода — так не важно, как статья режет сериал на сезоны.

export type WikiEpisode = {
  /** Таблица: «страница#номер» — у списка серий это сезон, у мини-сериала рядом — своя таблица */
  table: string;
  /** Сквозной номер («12.5» у рекапов) и номер в сезоне — как в статье */
  overall: string | null;
  inSeason: string | null;
  title: string | null;
  /** Японское название серии — ключ сверки с другими источниками (календари показа у них расходятся, название — нет) */
  titleJa?: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  text: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", copy: "©", times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Текст из HTML: без сносок «[1]», скрытых блоков и тегов, пробелы схлопнуты. */
export function htmlText(html: string): string {
  const t = html
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?<\/sup>/gs, "")
    .replace(/<span[^>]*display:\s*none[^>]*>.*?<\/span>\s*<\/span>|<span[^>]*display:\s*none[^>]*>[^<]*<\/span>/gs, "")
    .replace(/<style[^>]*>.*?<\/style>/gs, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(t).replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

const cellText = (html: string) => htmlText(html).replace(/\s+/g, " ").trim();

/** Строки серий со всех таблиц страницы. */
export function parseEpisodeTables(html: string, page = ""): WikiEpisode[] {
  const out: WikiEpisode[] = [];
  // Таблицы по порядку: номер таблицы — по началу <table>, в которой стоит строка
  const tableStarts = [...html.matchAll(/<table\b/g)].map((m) => m.index!);
  const rowRe = /<tr[^>]*class="[^"]*module-episode-list-row[^"]*"[^>]*>(.*?)<\/tr>(\s*<tr[^>]*class="[^"]*expand-child[^"]*"[^>]*>(.*?)<\/tr>)?/gs;
  for (const m of html.matchAll(rowRe)) {
    const row = m[1];
    const table = `${page}#${tableStarts.filter((s) => s < m.index!).length}`;
    const th = row.match(/<th[^>]*scope="row"[^>]*>(.*?)<\/th>/s);
    const cells = [...row.matchAll(/<td([^>]*)>(.*?)<\/td>/gs)];
    const summaryAt = cells.findIndex((c) => /class="[^"]*summary/.test(c[1]));
    // До названия — номер в сезоне (если сквозной в <th>), иначе единственный номер
    const before = (summaryAt < 0 ? [] : cells.slice(0, summaryAt)).map((c) => cellText(c[2])).filter((x) => /^\d+(\.\d+)?$/.test(x));
    const overall = th ? cellText(th[1]).match(/^\d+(\.\d+)?/)?.[0] ?? null : before[0] ?? null;
    const inSeason = th ? before[0] ?? null : null;
    const titleCell = summaryAt >= 0 ? cellText(cells[summaryAt][2]) : "";
    const title = titleCell.match(/^"(.+?)"/)?.[1] ?? (titleCell.split(/Transliteration:/)[0].trim() || null);
    const titleJa = summaryAt >= 0 ? cells[summaryAt][2].match(/<span lang="ja">(.*?)<\/span>/s)?.[1] : undefined;
    const iso = row.match(/class="[^"]*dtstart[^"]*"[^>]*>(\d{4}-\d{2}-\d{2})</)?.[1] ?? null;
    const desc = m[3]?.match(/<td[^>]*class="[^"]*description[^"]*"[^>]*>(.*)<\/td>/s)?.[1] ?? "";
    out.push({ table, overall, inSeason, title, titleJa: titleJa ? cellText(titleJa) || null : null, date: iso, text: htmlText(desc) });
  }
  return out;
}

export type SeasonWindow = {
  /** YYYY-MM-DD — начало и конец показа тайтла AniList (конца нет — идёт сейчас) */
  start: string | null;
  end: string | null;
  /** Объявлено серий (null — неизвестно) */
  count: number | null;
};

const DAY = 86400_000;

// Та же серия в другой таблице: в тот же день, с тем же названием или сквозным номером (в двух статьях название пишут по-разному)
const sameEpisode = (a: WikiEpisode, b: WikiEpisode) =>
  a.date === b.date && ((a.title ?? "").toLowerCase() === (b.title ?? "").toLowerCase() || (a.overall !== null && a.overall === b.overall));

/**
 * Серии тайтла по датам выхода (±3 дня от начала/конца показа), по порядку, с номерами 1…N.
 * Основная таблица — где больше серий в окне (рядом может идти мини-сериал в те же даты), при равенстве — где больше описаний.
 * Описание серии без описания берётся из другой таблицы с той же серией (общий список серий + статья сезона).
 * Рекапы с дробным номером выбрасываются, если без них число серий сходится.
 */
export function pickSeason(rows: WikiEpisode[], w: SeasonWindow, today = new Date().toISOString().slice(0, 10)): (WikiEpisode & { ep: number })[] {
  if (!w.start) return [];
  const from = Date.parse(w.start) - 3 * DAY;
  // У онгоинга — по сегодняшний день: в статье бывают уже объявленные, но не вышедшие серии
  const to = w.end ? Date.parse(w.end) + 3 * DAY : Date.parse(today);
  const inWindow = rows.filter((r) => r.date && Date.parse(r.date) >= from && Date.parse(r.date) <= to);
  const tables = new Map<string, WikiEpisode[]>();
  for (const r of inWindow) tables.set(r.table, [...(tables.get(r.table) ?? []), r]);
  const score = (t: WikiEpisode[]) => t.length * 1000 + t.filter((r) => r.text).length;
  const main = [...tables.values()].sort((a, b) => score(b) - score(a))[0] ?? [];
  let eps = main.map((r) => {
    if (r.text) return r;
    const twin = inWindow.find((x) => x.text && x.table !== r.table && sameEpisode(x, r));
    return twin ? { ...r, text: twin.text } : r;
  }).sort((a, b) => a.date!.localeCompare(b.date!) || Number(a.overall ?? 0) - Number(b.overall ?? 0));
  if (w.count !== null && eps.length > w.count) {
    const whole = eps.filter((r) => !r.overall?.includes("."));
    if (whole.length >= w.count) eps = whole;
  }
  if (w.count !== null) eps = eps.slice(0, w.count);
  return eps.map((r, i) => ({ ...r, ep: i + 1 }));
}

export type Dated = { ep: number; date: string | null; titleJa?: string | null };

/** Японское название для сравнения: без фуриганы ({{Ruby|冒|ぼう}} → 冒), пробелов, знаков и кавычек, NFKC. */
export function normJaTitle(s: string | null | undefined): string {
  return (s ?? "").replace(/\{\{\s*ruby\s*\|([^|}]*)\|[^}]*\}\}/gi, "$1").replace(/\{\{[^}]*\}\}|<[^>]+>/g, "")
    .normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Дата показа по японскому времени (расписание AniList — unix-время выхода). */
export const jstDate = (unix: number) => new Date((unix + 9 * 3600) * 1000).toISOString().slice(0, 10);

/**
 * Привязать строки источника к сериям эталонной шкалы: сначала по японскому названию серии (совпало —
 * это она, даже если даты показа расходятся), остальные — по дате выхода (±tol дней): строка получает
 * самую раннюю ещё свободную серию с подходящей датой, серии одного дня — по порядку. Строка без пары
 * не берётся: порядковый номер ненадёжен (у одной серии нет даты — все следующие съезжают на одну).
 */
export function alignToTimeline<T extends { date: string | null; overall?: string | null; titleJa?: string | null }>(rows: T[], timeline: Dated[], tol = 1): (T & { ep: number })[] {
  const free = [...timeline].sort((a, b) => a.ep - b.ep);
  const used = new Set<number>();
  const out: (T & { ep: number })[] = [];
  const byTitle = new Map<string, Dated>();
  for (const x of free) {
    const k = normJaTitle(x.titleJa);
    if (k && !byTitle.has(k)) byTitle.set(k, x);
  }
  const rest: T[] = [];
  for (const r of rows) {
    const hit = byTitle.get(normJaTitle(r.titleJa));
    if (hit && !used.has(hit.ep)) {
      used.add(hit.ep);
      out.push({ ...r, ep: hit.ep });
    } else rest.push(r);
  }
  const sorted = rest.filter((r) => r.date).sort((a, b) => a.date!.localeCompare(b.date!) || Number(a.overall ?? 0) - Number(b.overall ?? 0));
  for (const r of sorted) {
    const t = Date.parse(r.date!);
    const hit = free.find((x) => !used.has(x.ep) && x.date !== null && Math.abs(Date.parse(x.date) - t) <= tol * DAY);
    if (!hit) continue;
    used.add(hit.ep);
    out.push({ ...r, ep: hit.ep });
  }
  return out.sort((a, b) => a.ep - b.ep);
}
