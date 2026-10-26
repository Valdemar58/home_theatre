// Разбор названий раздач с русских трекеров (RuTracker и похожие).
// Типичный вид:
//   Русское (S3, часть 1) / Romaji 3rd Season / English [TV] E24 of 24 [RUS(int), JAP] [2024, жанры, WEB-DL] [1080p] AniLibria
//   Большой Куш / One Piece [TV] [1156-1180 из 1000+] [RUS(ext), JAP] [1999, ..., WEB-DL] [1080p]
// Модуль чистый (без серверных зависимостей), чтобы его можно было тестировать.

export type ReleaseKind = "TV" | "Movie" | "OVA" | "ONA" | "Special" | "Unknown";

export type ParsedRelease = {
  /** Все варианты названия (русские и латинские), без пометок сезона в скобках */
  names: string[];
  /** Номер сезона, если указан: (S3), (ТВ-3), 3rd Season, Season 3 */
  season: number | null;
  /** Часть сезона: (S3, часть 2), Part 2, Dai 2 Bu */
  part: number | null;
  kind: ReleaseKind;
  /** Номера серий в нумерации раздачи (обычно внутри сезона, у длинных сериалов — сквозная) */
  episodes: { from: number; to: number } | null;
  /** Сколько серий в сезоне всего (null — неизвестно, «из XX», «из 1000+») */
  total: number | null;
  /** Раздача содержит все серии сезона */
  complete: boolean;
  audio: {
    /** Русская дорожка: встроена (int), отдельными файлами (ext) или есть, но не указано как */
    rus: "int" | "ext" | "yes" | null;
    /** Языки дорожек: RUS, JAP, ENG, ... */
    langs: string[];
    /** Тип перевода из названия: Dub, MVO, DVO, AVO, VO */
    kinds: string[];
  };
  /** Студии озвучки, если указаны в названии */
  voices: string[];
  year: number | null;
  source: string | null;
  resolution: string | null;
  hdr: boolean;
};

const CYRILLIC = /[а-яё]/i;
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 };

// Известные студии озвучки, которые иногда пишут прямо в названии
const KNOWN_VOICES = [
  "AniLibria", "AniDUB", "AniMedia", "AniStar", "AnimeVost", "Dream Cast", "StudioBand", "JAM", "SHIZA",
  "Jaskier", "Crunchyroll", "Wakanim", "Reanimedia", "MC Entertainment", "Persona99", "Amazing Dubbing",
  "Kansai", "DEEP", "TVShows", "LostFilm", "HDrezka", "NewStudio", "Кубик в Кубе", "Анимедиа",
];

const NON_VIDEO = /^\s*\((OST|Music|Soundtrack)\)|\[(английский|японский|русский|manga|LN)|\b(EPUB|FB2|MP3|FLAC|lossless|kbps|PDF|CBR|CBZ)\b|\[(Nintendo|PS[345]|Xbox|PC)\b|\bRePack\b/i;

/** Разбить строку по скобкам [..] верхнего уровня: заголовок до первой скобки и список скобок. */
function splitBrackets(title: string): { head: string; brackets: { text: string; after: string }[] } {
  const brackets: { text: string; after: string }[] = [];
  const first = title.search(/\s\[/);
  const head = (first >= 0 ? title.slice(0, first) : title).trim();
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  const rest = first >= 0 ? title.slice(first) : "";
  const parts: { text: string; start: number; end: number }[] = [];
  while ((m = re.exec(rest))) parts.push({ text: m[1].trim(), start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < parts.length; i++) {
    const after = rest.slice(parts[i].end, parts[i + 1]?.start ?? rest.length).trim();
    brackets.push({ text: parts[i].text, after });
  }
  return { head, brackets };
}

/** (S3), (S3, часть 1), (ТВ-3), (TV-2), (ТВ-1, часть 1 + часть 2) */
function seasonFromParens(s: string): { season: number | null; part: number | null } {
  const m = s.match(/\((?:S|ТВ|TV)\s*-?\s*(\d+)(?:\s*,\s*(?:часть|part)\s*(\d+))?[^)]*\)/i);
  if (m) return { season: Number(m[1]), part: m[2] ? Number(m[2]) : null };
  const p = s.match(/\((?:часть|part)\s*(\d+)\)/i);
  return { season: null, part: p ? Number(p[1]) : null };
}

/** 3rd Season, Season 3, 2nd Season Part 2, Dai 2 Bu, Final Season, III, «Title 4» */
export function seasonFromName(name: string): { season: number | null; part: number | null } {
  let season: number | null = null;
  let part: number | null = null;
  const ord = name.match(/\b(\d+)(?:st|nd|rd|th)\s+Season\b/i) ?? name.match(/\bSeason\s+(\d+)\b/i) ?? name.match(/\bS(\d{1,2})\b/);
  if (ord) season = Number(ord[1]);
  const word = name.match(/\b(first|second|third|fourth|fifth|sixth)\s+season\b/i);
  if (!season && word) season = ORDINALS[word[1].toLowerCase()];
  const roman = name.match(/\s(II|III|IV|V|VI|VII)(?::|\s|$)/);
  if (!season && roman) season = ROMAN[roman[1]];
  // «Title 4» — номер сезона, но не «Part 1» / «Cour 2»
  const trailing = /\b(Part|Cour|Vol\.?|Bu)\s+\d$/i.test(name) ? null : name.match(/[^\d\s:]\s+(\d)$/);
  if (!season && trailing) season = Number(trailing[1]);
  const p = name.match(/\bPart\s+(\d+)\b/i) ?? name.match(/\bDai\s+(\d+)\s+Bu\b/i) ?? name.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:Part|Cour)\b/i);
  if (p) part = Number(p[1]);
  return { season, part };
}

/** Убрать из названия пометки сезона, чтобы сравнивать с названиями сериала */
export function stripSeason(name: string): string {
  return name
    .replace(/\((?:S|ТВ|TV)\s*-?\s*\d+[^)]*\)/gi, "")
    .replace(/\((?:часть|part)\s*\d+\)/gi, "")
    .trim();
}

type EpisodesInfo = { from: number; to: number; total: number | null; specials: number };

/** «E24 of 24», «E24+2 of 24+2», «S1E1-2 of 2», «E01-11 of 14» (так их нормализует Prowlarr) */
function episodesFromE(s: string): EpisodesInfo | null {
  const m = s.match(/(?:S\d+)?E(\d+)(?:-(\d+))?(?:\+(\d+))?\s+of\s+(\d+|X+|\?+)(?:\+(\d+))?/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : null;
  return {
    from: b ? a : 1,
    to: b ?? a,
    total: /^\d+$/.test(m[4]) ? Number(m[4]) : null,
    specials: m[3] ? Number(m[3]) : 0,
  };
}

/** «1-24 из 24», «01-11 из 14», «23 из 23», «1156-1180 из 1000+», «1-6 из 12+1», «1-497 из XX - JAP» */
function episodesFromBracket(s: string): EpisodesInfo | null {
  // «из 1000+» — число неизвестно; «из 24+2» — 24 серии и 2 спешла
  const m = s.match(/^(\d+)(?:\s*-\s*(\d+))?(?:\+(\d+))?\s+из\s+(\d+|X+|\?+)(\+(?!\d))?(?:\+(\d+))?/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : null;
  const total = /^\d+$/.test(m[4]) && !m[5] ? Number(m[4]) : null;
  return { from: b ? a : 1, to: b ?? a, total, specials: m[3] ? Number(m[3]) : 0 };
}

function parseAudio(s: string, into: ParsedRelease["audio"]): boolean {
  // [RUS(int), JAP], [RUS(ext), ENG, JAP], [RUS(MVO)], [JAP], [RUS(Dub)]
  if (!/^(RUS|JAP|JPN|ENG|UKR|KOR|CHN|KAZ|UZB)\b/i.test(s)) return false;
  for (const raw of s.split(/\s*,\s*/)) {
    const m = raw.match(/^([A-Z]{3})(?:\s*\(([^)]*)\))?/i);
    if (!m) continue;
    const lang = m[1].toUpperCase() === "JPN" ? "JAP" : m[1].toUpperCase();
    if (!into.langs.includes(lang)) into.langs.push(lang);
    if (lang === "RUS") {
      const flag = (m[2] ?? "").toLowerCase();
      if (flag.includes("int")) into.rus = "int";
      else if (flag.includes("ext")) into.rus = into.rus === "int" ? "int" : "ext";
      else into.rus ??= "yes";
      for (const kind of ["Dub", "MVO", "DVO", "AVO", "VO"]) {
        if (new RegExp(`\\b${kind}\\b`, "i").test(flag) && !into.kinds.includes(kind)) into.kinds.push(kind);
      }
    }
  }
  return true;
}

const SOURCES: [RegExp, string][] = [
  [/\bUHD\s*BDRemux|BDRemux|Blu-?ray\s*Remux|\bRemux\b/i, "BDRemux"],
  [/\bUHD\s*BDRip|BDRip|BRRip|\bBD\b|Blu-?ray/i, "BDRip"],
  [/WEB-?DL/i, "WEB-DL"],
  [/WEB-?Rip|\bWEB\b/i, "WEBRip"],
  [/HDTV-?Rip|HDTV/i, "HDTVRip"],
  [/DVD-?Rip|DVD5|DVD9|\bDVD\b/i, "DVDRip"],
  [/\bTV-?Rip\b|SATRip/i, "TVRip"],
];

export function parseRelease(title: string): ParsedRelease | null {
  if (NON_VIDEO.test(title)) return null;
  const { head, brackets } = splitBrackets(title);

  const out: ParsedRelease = {
    names: [], season: null, part: null, kind: "Unknown", episodes: null, total: null, complete: false,
    audio: { rus: null, langs: [], kinds: [] }, voices: [], year: null, source: null, resolution: null, hdr: false,
  };

  // --- названия и пометки сезона в заголовке
  const fromParens = seasonFromParens(head);
  out.season = fromParens.season;
  out.part = fromParens.part;
  for (const seg of head.split(/\s+\/\s+/)) {
    const name = stripSeason(seg).replace(/\s+/g, " ").trim();
    if (!name || /^S\d+E[\d-]+\s+of/i.test(name)) continue;
    out.names.push(name);
    if (!CYRILLIC.test(name)) {
      const s = seasonFromName(name);
      out.season ??= s.season;
      out.part ??= s.part;
    }
  }
  if (!out.names.length) return null;

  // --- скобки и текст между ними
  let episodes: EpisodesInfo | null = null;
  let rusEpisodes: EpisodesInfo | null = null;
  let pendingEpisodes: EpisodesInfo | null = null;
  const tail: string[] = [];
  for (const { text, after } of brackets) {
    const kind = text.match(/^(TV|Movie|OVA|ONA|Special|Спешл|Фильм)(\+[A-Za-z]+)*$/i);
    if (kind) {
      const k = kind[1].toLowerCase();
      out.kind = k === "tv" ? "TV" : k === "movie" || k === "фильм" ? "Movie" : k === "ova" ? "OVA" : k === "ona" ? "ONA" : "Special";
    } else if (episodesFromBracket(text)) {
      pendingEpisodes = episodesFromBracket(text);
      episodes ??= pendingEpisodes;
      // «[1-205 из XX - RUS(int)]»: серии с русской дорожкой
      if (/RUS/i.test(text)) rusEpisodes = pendingEpisodes;
    } else if (parseAudio(text, out.audio)) {
      if (out.audio.rus && pendingEpisodes) rusEpisodes ??= pendingEpisodes;
    } else if (/\b(19|20)\d{2}\b/.test(text) && text.includes(",")) {
      out.year = Number(text.match(/\b((?:19|20)\d{2})\b/)![1]);
      for (const [re, name] of SOURCES) if (re.test(text)) { out.source = name; break; }
      const res = text.match(/\b(2160|1080|720|576|480)[pi]\b/i);
      if (res) out.resolution = `${res[1]}p`;
      if (/HDR|Dolby\s*Vision|\bDV\b/i.test(text)) out.hdr = true;
    } else if (/^(2160|1080|720|576|480)[pi]$/i.test(text)) {
      out.resolution = `${text.slice(0, -1)}p`;
    } else if (/HDR|Dolby\s*Vision/i.test(text)) {
      out.hdr = true;
    }
    // Нормализованные Prowlarr серии стоят прямо в тексте между скобками: «[TV] E24 of 24 [RUS...]»
    if (after) {
      for (const chunk of after.split(/\s*&\s*/)) {
        const e = episodesFromE(chunk);
        if (e) {
          pendingEpisodes = e;
          episodes ??= e;
        }
      }
      tail.push(after);
    }
  }
  // Серии в заголовке: «LEGO One Piece / S1E1-2 of 2»
  episodes ??= episodesFromE(head);

  const chosen = rusEpisodes ?? episodes;
  if (chosen) {
    out.episodes = { from: chosen.from, to: chosen.to };
    out.total = chosen.total;
    out.complete = chosen.total !== null && chosen.from <= 1 && chosen.to >= chosen.total;
  }
  if (out.kind === "Movie") out.complete = true;

  // --- студии озвучки: в «хвосте» после скобок или в тексте
  const tailText = tail.join(" ") + " " + (brackets.at(-1)?.after ?? "");
  for (const v of KNOWN_VOICES) {
    if (new RegExp(`(^|[^\\p{L}])${v.replace(/\s+/g, "\\s*")}([^\\p{L}]|$)`, "iu").test(tailText) && !out.voices.includes(v)) {
      out.voices.push(v);
    }
  }
  // Если в названии озвучки нет, но студия указана — русская дорожка есть
  if (!out.audio.rus && out.voices.length) out.audio.rus = "yes";

  // Видео без признаков сериала/фильма — скорее всего не то (книги, музыка без меток и т.п.)
  if (out.kind === "Unknown" && !out.episodes && !out.source) return null;
  return out;
}

/** Нормализация названия для сравнения: регистр, пунктуация, ё, лишние пробелы. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
