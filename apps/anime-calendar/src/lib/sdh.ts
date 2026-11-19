import { normJaTitle } from "./wiki-episodes";

// Японские субтитры для слабослышащих (SDH, ja[cc]): разбор SRT/ASS в реплики.
// Метка в начале строки «（三上）…» — говорящий или звук («（爆発音）»); фуригана «防空壕(ぼうくうごう)» — чтение;
// «♪» — музыка; «〈…〉»/«＜…＞» — голос из-за кадра (телефон, мысль, издалека). Чистые функции, без сети.

export type CueKind = "speech" | "sound" | "music" | "offscreen";

export type CueLine = {
  kind: CueKind;
  /** Говорящий по метке (без чтения); несколько — «沢渡･田村» → два имени */
  speakers: string[];
  text: string;
};

export type Cue = {
  start: number; // мс
  end: number;
  lines: CueLine[];
  /** ASS: стиль, цвет и позиция строки — подсказки для атрибуции без метки */
  style?: string;
  color?: string;
  pos?: string;
};

export type ParsedSubs = {
  cues: Cue[];
  /** Чтения имён и слов из фуриганы: 三上 → みかみ */
  readings: Record<string, string>;
  /** Блоков с таймингом в файле — для проверки, что ничего не потеряно */
  blocks: number;
};

const ts = (h: string, m: string, s: string, ms: string) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, "0").slice(0, 3));

// Фуригана: кандзи + (кана) в полуширинных скобках; метки — в полноширинных «（）»
const FURIGANA = /([\p{Script=Han}々〆ヶ]+)\(([\p{Script=Hiragana}\p{Script=Katakana}ー]+)\)/gu;

function stripFurigana(s: string, readings: Record<string, string>): string {
  return s.replace(FURIGANA, (_, kanji: string, kana: string) => {
    readings[kanji] ??= kana;
    return kanji;
  });
}

// Звук, а не говорящий: «爆発音», «人々の悲鳴», «女の悲鳴», «水に落ちた音», «正解音», «拍手»
const SOUND = /(音|声|叫び|悲鳴|ざわめき|どよめき|笑い|泣き|歓声|拍手|鳴き|ため息|吐息|息遣い|うなり|咆哮|爆発|銃声|雷鳴|物音|チャイム|ベル|サイレン|アラーム|BGM|音楽|口笛|いびき|寝息|せき|咳)$/u;

/** Метка «（…）» — говорящий или звук. names — известные имена тайтла (справочник персонажей): имя важнее суффикса. */
export function isSoundLabel(label: string, names: Set<string> = new Set()): boolean {
  const l = label.trim();
  if (names.has(l)) return false;
  return SOUND.test(l) || /の(音|声)/u.test(l);
}

const splitSpeakers = (label: string) => label.split(/[･・、,]/).map((x) => x.replace(/\s+/g, "").trim()).filter(Boolean);

/** Строки одной реплики: метка на отдельной строке относится к следующим строкам той же реплики. */
export function cueLines(raw: string[], readings: Record<string, string>, names: Set<string> = new Set()): CueLine[] {
  const out: CueLine[] = [];
  let speakers: string[] = [];
  for (let line of raw) {
    line = stripFurigana(line.trim(), readings);
    if (!line) continue;
    if (/^[♪～〜\s]+$|^♪|♪$/.test(line)) {
      out.push({ kind: "music", speakers: [], text: line.replace(/♪/g, "").trim() });
      continue;
    }
    const m = line.match(/^（([^）]{1,40})）\s*(.*)$/u);
    if (m) {
      const label = m[1].trim();
      const rest = m[2].trim();
      if (isSoundLabel(label, names)) {
        out.push({ kind: "sound", speakers: [], text: label });
        if (rest) out.push({ kind: "speech", speakers, text: rest });
        continue;
      }
      speakers = splitSpeakers(label);
      if (!rest) continue;
      line = rest;
    }
    const off = line.match(/^[〈＜<](.*)[〉＞>]$/u);
    out.push(off ? { kind: "offscreen", speakers, text: off[1].trim() } : { kind: "speech", speakers, text: line });
  }
  return out;
}

/** SRT: блоки «номер / тайминг / текст». Теги <i>, {\an8} — убираются. */
export function parseSrt(src: string, names?: Set<string>): ParsedSubs {
  const readings: Record<string, string> = {};
  const cues: Cue[] = [];
  let blocks = 0;
  for (const block of src.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => /-->/.test(l));
    if (ti < 0) continue;
    const t = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!t) continue;
    blocks++;
    const text = lines.slice(ti + 1).map((l) => l.replace(/<[^>]+>|\{[^}]*\}/g, ""));
    cues.push({ start: ts(t[1], t[2], t[3], t[4]), end: ts(t[5], t[6], t[7], t[8]), lines: cueLines(text, readings, names) });
  }
  return { cues, readings, blocks };
}

const assTime = (s: string) => {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[.](\d+)/);
  return m ? ts(m[1], m[2], m[3], m[4].padEnd(3, "0")) : 0;
};

/** ASS: строки Dialogue из [Events]; \N — перенос, {\c&H…&}, {\pos(…)} — цвет и позиция. Подписи-надписи (стили sign/song) — не реплики. */
export function parseAss(src: string, names?: Set<string>): ParsedSubs {
  const readings: Record<string, string> = {};
  const cues: Cue[] = [];
  let blocks = 0;
  let format: string[] = [];
  let inEvents = false;
  for (const raw of src.replace(/^﻿/, "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = line.toLowerCase() === "[events]"; continue; }
    if (!inEvents) continue;
    if (line.startsWith("Format:")) { format = line.slice(7).split(",").map((x) => x.trim().toLowerCase()); continue; }
    if (!line.startsWith("Dialogue:") || !format.length) continue;
    const parts = line.slice(9).split(",");
    const f = Object.fromEntries(format.slice(0, -1).map((k, i) => [k, parts[i]?.trim() ?? ""]));
    const text = parts.slice(format.length - 1).join(",");
    blocks++;
    const style = f.style ?? "";
    if (/sign|song|op|ed|title|karaoke/i.test(style) && !/dialog|default|main/i.test(style)) continue;
    const color = text.match(/\\1?c&H([0-9A-Fa-f]{6})&/)?.[1]?.toUpperCase();
    const pos = text.match(/\\pos\(([^)]+)\)/)?.[1] ?? (text.match(/\\an(\d)/)?.[1] ? `an${text.match(/\\an(\d)/)![1]}` : undefined);
    const lines = text.replace(/\{[^}]*\}/g, "").split(/\\N|\\n/);
    cues.push({ start: assTime(f.start), end: assTime(f.end), lines: cueLines(lines, readings, names), style, color, pos });
  }
  return { cues, readings, blocks };
}

export const parseSubs = (name: string, src: string, names?: Set<string>): ParsedSubs =>
  /\.(ass|ssa)$/i.test(name) ? parseAss(src, names) : parseSrt(src, names);

/** Номер серии из имени файла: «S01E05», «第5話», «Ep 05», « - 05», «E05». */
export function episodeOfFile(name: string): number | null {
  const n = name.replace(/\[[^\]]*\]/g, " ");
  const m = n.match(/S\d{1,2}E(\d{1,3})/i) ?? n.match(/第(\d{1,3})話/) ?? n.match(/\bEp(?:isode)?\.?\s*(\d{1,3})\b/i) ?? n.match(/\s-\s(\d{1,3})(?:v\d)?\b/) ?? n.match(/\bE(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Насколько файл годится как SDH: Amazon [sdh] и Netflix ja[cc] — со звуками и именами;
 * у ТВ-рипов звуки часто вырезаны. Половинки серий (E24.5), английские и двуязычные — ниже.
 */
export function sdhRank(name: string): number {
  const n = name.toLowerCase();
  if (/\.(zip|7z|rar)$/.test(n)) return -1;
  if (!/\.(srt|ass|ssa)$/.test(n)) return -1;
  if (/e\d+\.5\b/.test(n)) return -1;
  if (/ja-en|\.en\.|eng(?!.*\.ja)/.test(n) && !/\.ja(-jp)?(\[|\.)/.test(n)) return 0;
  let r = 1;
  if (/\[sdh\]|\[cc\]/.test(n)) r += 4;
  // Netflix выше Amazon: Amazon подписывает таинственных персонажей настоящими именами раньше, чем их узнаёт зритель
  if (/netflix/.test(n)) r += 1.5;
  if (/amazon/.test(n)) r += 1;
  if (/\.srt$/.test(n)) r += 0.5;
  return r;
}

/** «第48話», «第48.5話» — номер из японской части имени (у продолжений бывает сквозной по всем сезонам). */
const kanjiEp = (name: string) => {
  const m = name.match(/第(\d{1,4}(?:\.\d)?)話/);
  return m ? Number(m[1]) : null;
};

/**
 * Файлы → серии тайтла. Номер в имени ненадёжен (у загрузчиков «S01E01.第2話», сквозная нумерация «第48話»),
 * поэтому сначала японское название серии из справочника (titles: серия → название), потом «第N話»
 * (со сдвигом, если нумерация сквозная), потом SxxEyy / «Ep NN». Среди файлов одной серии — лучший по sdhRank.
 */
export function matchFiles<F extends { name: string }>(files: F[], titles: Map<number, string>, count: number | null): Map<number, F> {
  const norm = [...titles].map(([ep, t]) => [ep, normJaTitle(t)] as const).filter(([, t]) => t.length >= 3);
  const ok = files.filter((f) => sdhRank(f.name) > 0);
  // Сдвиг сквозной нумерации: «第N話» больше числа серий — считаем от наименьшего целого номера
  const nums = ok.map((f) => kanjiEp(f.name)).filter((n): n is number => n !== null && Number.isInteger(n));
  const shift = count && nums.length && Math.max(...nums) > count ? Math.min(...nums) - 1 : 0;
  const best = new Map<number, { f: F; rank: number }>();
  for (const f of ok) {
    const n = normJaTitle(f.name);
    const byTitle = norm.filter(([, t]) => n.includes(t)).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
    const k = kanjiEp(f.name);
    const ep = byTitle ?? (k !== null ? (Number.isInteger(k) ? k - shift : null) : episodeOfFile(f.name));
    if (ep === null || ep < 1 || (count && ep > count)) continue;
    const rank = sdhRank(f.name);
    const cur = best.get(ep);
    if (!cur || rank > cur.rank) best.set(ep, { f, rank });
  }
  return new Map([...best].sort((a, b) => a[0] - b[0]).map(([ep, { f }]) => [ep, f]));
}

/** Что прозвучало в серии вслух (реплики и голос из-за кадра) — по этому тексту решаем, какие имена зритель уже слышал. */
export const spokenText = (p: ParsedSubs) =>
  p.cues.flatMap((c) => c.lines.filter((l) => l.kind === "speech" || l.kind === "offscreen").map((l) => l.text)).join("\n");

const nameParts = (n: string) => [n, ...n.split(/[・＝=\s]/)].map((x) => x.trim()).filter((x) => x.length >= 2);

/**
 * Метки говорящих, которые раскрывают имя раньше, чем его произнесли (SDH подписывает таинственного персонажа
 * настоящим именем): имя персонажа (по справочнику), не звучавшее в репликах этой и прошлых серий, —
 * «人物A», «人物B»… Роли («少女», «通行人») и уже прозвучавшие имена остаются.
 */
export function maskUnheard(p: ParsedSubs, heard: string, names: Set<string>): ParsedSubs {
  const parts = new Set([...names].flatMap(nameParts));
  const alias = new Map<string, string>();
  const mask = (sp: string) => {
    if (!parts.has(sp) || heard.includes(sp)) return sp;
    if (!alias.has(sp)) alias.set(sp, `人物${String.fromCharCode(65 + alias.size)}`);
    return alias.get(sp)!;
  };
  return { ...p, cues: p.cues.map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, speakers: l.speakers.map(mask) })) })) };
}

/** Словарь имён — только персонажи, чьё японское имя (или его часть) уже прозвучало. */
export function heardGlossary<E extends { names: string[] }>(entries: E[], heard: string): E[] {
  return entries.filter((e) => e.names.some((n) => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]/u.test(n) && nameParts(n).some((x) => heard.includes(x))));
}
