// Надписи из полной ASS-дорожки (TASKS 9.5): вывески, записки, титры, песни — всё, что не реплики. Фансаб отмечает их
// стилем («Sign», «Note», «Title», «OP/ED», «Song») или ставит в нужное место кадра (\pos, \move, \clip) — реплики
// идут внизу по умолчанию. Из надписей собирается отдельная дорожка: шапка и стили — исходные, события — только
// надписи; текст можно заменить переводом, теги оформления в начале строки сохраняются.

export type AssEvent = {
  /** Строка целиком (Dialogue: …) — без изменения, если текст не трогали */
  raw: string;
  /** Поля до Text (Layer, Start, End, Style, Name, …) */
  head: string;
  style: string;
  name: string;
  /** Text — с тегами */
  text: string;
};

export type AssParts = { header: string[]; format: string; events: AssEvent[] };

const SIGN_STYLE = /sign|note|title|caption|screen|insert|board|text|letter|kanji|op\b|ed\b|opening|ending|song|kara|lyric|надпис|титр|песн/i;
const DIALOG_STYLE = /dialog|default|main|italic|flashback|thought|top|alt|overlap|narrat|speech|^def/i;
const PLACED = /\\(pos|move|clip|iclip|org)\s*\(/;

/** ASS → шапка (Script Info, стили и прочее до событий), формат событий и события Dialogue. */
export function splitAss(src: string): AssParts {
  const header: string[] = [];
  const events: AssEvent[] = [];
  let format = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
  let fields: string[] = format.slice(7).split(",").map((x) => x.trim().toLowerCase());
  let inEvents = false;
  for (const raw of src.replace(/^﻿/, "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = line.toLowerCase() === "[events]";
      if (!inEvents) header.push(raw);
      continue;
    }
    if (!inEvents) { header.push(raw); continue; }
    if (line.startsWith("Format:")) { format = line; fields = line.slice(7).split(",").map((x) => x.trim().toLowerCase()); continue; }
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.slice(9).trimStart().split(",");
    const n = fields.length - 1;
    const f = Object.fromEntries(fields.slice(0, n).map((k, i) => [k, parts[i]?.trim() ?? ""]));
    events.push({ raw: line, head: parts.slice(0, n).join(","), style: f.style ?? "", name: f.name ?? f.actor ?? "", text: parts.slice(n).join(",") });
  }
  // Пустые строки в конце шапки — лишние
  while (header.length && !header.at(-1)!.trim()) header.pop();
  return { header, format, events };
}

/** Надпись ли это: по стилю, иначе — поставлена в конкретное место кадра и стиль не «репличный». */
export function isSign(e: Pick<AssEvent, "style" | "text">): boolean {
  if (SIGN_STYLE.test(e.style) && !DIALOG_STYLE.test(e.style)) return true;
  if (DIALOG_STYLE.test(e.style)) return false;
  return PLACED.test(e.text);
}

/** Видимый текст события (без тегов, \N — перенос). */
export const plainText = (text: string) => text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();

/** Заменить текст события переводом: теги оформления из начала строки остаются, внутренние — нет (порядок слов другой). */
export function withText(e: AssEvent, translated: string): AssEvent {
  const lead = e.text.match(/^(\{[^}]*\})+/)?.[0] ?? "";
  const text = lead + translated.replace(/\r?\n/g, "\\N");
  return { ...e, text, raw: `Dialogue: ${e.head},${text}` };
}

/** Собрать дорожку: исходная шапка и стили, только эти события. */
export function buildAss(parts: Pick<AssParts, "header" | "format">, events: AssEvent[]): string {
  return [...parts.header, "", "[Events]", parts.format, ...events.map((e) => e.raw), ""].join("\n");
}

/** Надписи дорожки: события-надписи с видимым текстом (рисунки \p1 без текста — тоже, их не переводим). */
export function signEvents(parts: AssParts): AssEvent[] {
  return parts.events.filter(isSign);
}

/** Что переводить: уникальные видимые тексты надписей (рисунки и пустые — нет). */
export function signTexts(events: AssEvent[]): string[] {
  return [...new Set(events.filter((e) => !/\\p[1-9]/.test(e.text)).map((e) => plainText(e.text)).filter((t) => /\p{L}/u.test(t)))];
}
