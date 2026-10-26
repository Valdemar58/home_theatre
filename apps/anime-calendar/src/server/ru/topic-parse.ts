// Разбор страницы темы RuTracker: полное название и озвучки из первого сообщения.
// Модуль чистый, чтобы его можно было тестировать.

export type TopicInfo = {
  /** Полное название раздачи (Prowlarr иногда обрезает его посередине) */
  title: string | null;
  /** Студии/авторы русской озвучки: AniLibria, AniStar, DEEP... */
  voices: string[];
  /** Типы перевода: Dub, MVO, DVO, VO */
  kinds: string[];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);
const text = (html: string) => decode(html.replace(/<wbr\s*\/?>/gi, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// Единое написание известных студий
const CANONICAL: [RegExp, string][] = [
  [/^ani\s*libria(\.tv)?$/i, "AniLibria"],
  [/^анилибри\p{L}*$/iu, "AniLibria"],
  // С 2025 года AniLibria называется AniLiberty
  [/^ani\s*liberty$/i, "AniLiberty"],
  [/^анилиберти$/iu, "AniLiberty"],
  [/^анида[бп]\p{L}*$/iu, "AniDUB"],
  [/^анистар\p{L}*$/iu, "AniStar"],
  [/^анимедиа\p{L}*$/iu, "AniMedia"],
  [/^анимевост\p{L}*$/iu, "AnimeVost"],
  [/^шиз[аыеу]\p{L}*$/iu, "SHIZA"],
  [/^дрим\s*каст\p{L}*$/iu, "Dream Cast"],
  [/^студийн\p{L}*\s+банд\p{L}*$/iu, "StudioBand"],
  [/^ani\s*dub$/i, "AniDUB"],
  [/^ani\s*star$/i, "AniStar"],
  [/^ani\s*media$/i, "AniMedia"],
  [/^anime\s*vost$/i, "AnimeVost"],
  [/^dream\s*cast$/i, "Dream Cast"],
  [/^studio\s*band$/i, "StudioBand"],
  [/^shiza(\s*project)?$/i, "SHIZA"],
];

// Слова, которые попадают в скобки/после «от», но студиями не являются
const STOP = /(\bspecials?\b|спешл|\bmka\b|\bmkv\b|\bac-?3\b|\be-?ac-?3\b|\bopus\b|многоголос|двухголос|одноголос|закадров|дубляж|авторск|профессионал|любительск|русск|язык|канал|кбит|kbps|khz|кгц|\baac\b|\bac3\b|\bdts\b|\beac3\b|\bflac\b|\bch\b|внешн|состав|контейнер|только|\btv\b|субтитр|полн|надпис|original|оригинал|неизвестн|перевод|озвучк|звук|эп\.|серии|серия|спец|\d{2,}|ova|ona|bd|web|версия|vers)/i;

function canonical(name: string): string {
  const n = name.replace(/^(студи[ия]|studio)\s+/i, "").replace(/[«»"]/g, "").trim();
  for (const [re, c] of CANONICAL) if (re.test(n)) return c;
  return n;
}

function addVoice(list: string[], raw: string) {
  // «Анилибрии по заказу DEEP»: озвучивала AniLibria, DEEP — заказчик
  raw = raw.replace(/(^|\s+)по\s+заказу.*$/iu, "");
  // \b в JS не работает с кириллицей, поэтому границы слов — через \p{L}
  for (const part of raw.split(/\s*(?:,|&|\+|\/|(?<!\p{L})и(?!\p{L})|\band\b)\s*/iu)) {
    const name = canonical(part);
    if (name.length < 2 || name.length > 30 || STOP.test(name) || /^[\d\s.,-]+$/.test(name)) continue;
    if (!list.some((v) => v.toLowerCase() === name.toLowerCase())) list.push(name);
  }
}

const KINDS: [RegExp, string][] = [
  [/дубляж|\bdub\b/i, "Dub"],
  [/многоголос|\bmvo\b/i, "MVO"],
  [/двухголос|\bdvo\b/i, "DVO"],
  [/одноголос|авторск|\bavo\b|\bvo\b/i, "VO"],
];

export function parseTopic(html: string): TopicInfo {
  const titleHtml = html.match(/<h1[^>]*class="maintitle"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1];
  const title = titleHtml ? text(titleHtml) : null;

  // Первое сообщение темы — описание раздачи; дальше комментарии, их не читаем
  const start = html.indexOf('class="post_body"');
  const next = start >= 0 ? html.indexOf('class="post_body"', start + 10) : -1;
  // Срез начинается после «>» открывающего тега, иначе его остаток прилипнет к первой строке
  const body = start >= 0 ? html.slice(html.indexOf(">", start) + 1, next > 0 ? next : start + 60_000) : "";
  const lines = decode(body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li)>|<hr[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const voices: string[] = [];
  const kinds: string[] = [];
  for (const line of lines) {
    const isAudio = /^(Аудио|Звук|Озвучк|Дорожк)/i.test(line) || /^[^:]{0,25}звук\s*:/i.test(line);
    const isVoiceLine = /^Озвучк[аи]\s*:/i.test(line);
    if (!isAudio) continue;
    // Только русские дорожки (у японских тоже бывают «от Crunchyroll»)
    if (!isVoiceLine && !/(русск|\bRUS\b|\bRu\b)/i.test(line)) continue;
    for (const [re, kind] of KINDS) if (re.test(line) && !kinds.includes(kind)) kinds.push(kind);
    if (isVoiceLine) addVoice(voices, line.replace(/^Озвучк[аи]\s*:\s*/i, "").replace(/\([^)]*\)/g, ""));
    for (const m of line.matchAll(/\(([^)]{2,60})\)/g)) addVoice(voices, m[1]);
    for (const m of line.matchAll(/(?<!\p{L})от\s+([^|()\[\],]{2,40})/giu)) {
      addVoice(voices, m[1].replace(/\s+(только|для|в|на)(?!\p{L}).*$/iu, ""));
    }
    // «| AniLibria |» — отдельный сегмент между вертикальными чертами
    for (const seg of line.split("|").slice(1)) {
      const s = seg.trim();
      if (/^[A-Za-zА-Яа-яЁё0-9 .&'-]{2,25}$/.test(s) && /[A-Z]/.test(s)) addVoice(voices, s);
    }
  }
  return { title, voices, kinds };
}
