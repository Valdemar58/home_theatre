// Плеер календаря: что отдаёт сервер и правила выбора дорожек (без сети — для сервера, клиента и тестов).
// Поток — Jellyfin (HLS через прокси календаря, ключ Jellyfin в браузер не попадает).

export type PlayTrack = { index: number; label: string; lang: string | null; codec: string; title: string | null; external?: boolean };
export type PlaySub = PlayTrack & {
  url: string; ass: boolean; forced: boolean; signs: boolean; external: boolean; jimaku?: boolean; torrent?: boolean;
  /** Надписи, вынутые из полной ASS-дорожки (TASKS 9.5): из какой и нужен ли перевод на русский */
  fromSub?: { index: number; translate: boolean };
};

/** Индекс дорожки японских субтитров с Jimaku (не из файла — номера Jellyfin до неё не доходят). */
export const JIMAKU_SUB = 100_000;
/** Индексы русских субтитров из раздачи «Стрима» (отдельные файлы раздачи) — с этого номера. */
export const STREAM_SUB = 200_000;
/** Надписи из полной дорожки: SIGNS_SUB + номер исходной дорожки. */
export const SIGNS_SUB = 1_000_000;
export type PlayChapter = { name: string; start: number };
/** «Перевести кадр»: надпись в кадре — текст, перевод и рамка в долях 0–1000 кадра. */
export type FrameItem = { text: string; ru: string; box: [number, number, number, number] };

export type PlayInfo = {
  sid: string;
  /** Плейлист HLS (или файл целиком, если браузер играет его сам) */
  src: string;
  hls: boolean;
  /** Серия «Стрима» (TorrServer): есть состояние раздачи и скачанные куски */
  stream: boolean;
  duration: number;
  /** С какой секунды начинать (сохранённая позиция) */
  start: number;
  audio: PlayTrack[];
  audioIndex: number | null;
  subs: PlaySub[];
  subIndex: number | null;
  /** Шрифты из вложений файла — для ASS */
  fonts: string[];
  chapters: PlayChapter[];
  /** Озвучки раздачи «Стрима» отдельными файлами: have — уже рядом с серией (есть в audio), иначе — скачать звук (size, байт) */
  extVoices: { group: string; size: number; have: boolean }[];
  /** Опенинг и эндинг серии (главы файла или звуковой отпечаток) — кнопка «Пропустить» и отметки на шкале */
  segments: import("./fingerprint").Segment[];
  /** Миниатюры шкалы (trickplay Jellyfin): плитки cols×rows кадров width×height через interval мс; url + /<n>.jpg */
  trickplay: { width: number; height: number; cols: number; rows: number; count: number; interval: number; url: string } | null;
  /** Почему Jellyfin перекодирует (пусто — видео как есть) */
  transcode: string[];
};

/** Состояние потока серии «Стрима» — то же, что на странице «Загрузки». */
export type PlayStatus = {
  stream: {
    state: string; speed: number; peers: number; seeders: number; totalPeers: number; fileSize: number | null;
    /** Сколько байт/с нужно, чтобы смотреть без остановок */
    rate: number | null;
    prebuffer: { read: number; size: number; ready: boolean; done: boolean; etaSec: number | null } | null;
    /** Что уже скачано TorrServer: доли файла [начало, конец) — полоска под шкалой */
    cached: [number, number][];
  } | null;
};

/** Что умеет браузер: сервер собирает по этому профиль устройства для Jellyfin. */
export type PlayCaps = { hevc: boolean; av1: boolean; maxBitrate: number };

/** Совместимый режим: видео всегда перекодируется в H.264 (если браузер заявляет HEVC, но показывает чёрный экран). */
export const COMPAT_KEY = "player-compat";

const LANG_RU: Record<string, string> = {
  jpn: "японский", rus: "русский", eng: "английский", chi: "китайский", zho: "китайский", kor: "корейский",
  fre: "французский", fra: "французский", ger: "немецкий", deu: "немецкий", spa: "испанский", ita: "итальянский",
  por: "португальский", ara: "арабский", pol: "польский", ukr: "украинский",
};

/** Подпись дорожки: «Русский · AniLibria», «Японский · FLAC». */
export function trackLabel(lang: string | null, title: string | null, codec: string): string {
  const l = lang ? LANG_RU[lang.toLowerCase()] ?? lang : null;
  const name = l ? l[0].toUpperCase() + l.slice(1) : null;
  const t = title && !(l && title.toLowerCase().includes(l)) ? title : null;
  return [name, t ?? codec.toUpperCase()].filter(Boolean).join(" · ") || `Дорожка`;
}

const isRu = (t: PlayTrack) => t.lang?.toLowerCase() === "rus" || /рус|russian/i.test(t.title ?? "");
/** Надписи: дорожка только с вывесками и титрами (без диалогов) */
export const isSignsTitle = (title: string | null) => /надпис|sign|forced|титры/i.test(title ?? "");

/**
 * Озвучка по умолчанию: русская (студия из списка — если есть такая дорожка), иначе первая.
 * voice — студия, которую пользователь отметил у тайтла.
 */
export function pickAudio(tracks: PlayTrack[], voice: string | null): number | null {
  const ru = tracks.filter(isRu);
  const v = voice?.toLowerCase();
  const byVoice = v ? ru.find((t) => t.title?.toLowerCase().includes(v)) : undefined;
  return (byVoice ?? ru[0] ?? tracks[0])?.index ?? null;
}

/**
 * Субтитры по умолчанию: русская озвучка — надписи (если есть), без озвучки — русские полные, иначе английские.
 */
export function pickSub(subs: PlaySub[], audio: PlayTrack | undefined): number | null {
  const ru = subs.filter(isRu);
  if (audio && isRu(audio)) return (ru.find((s) => s.signs) ?? ru.find((s) => s.forced))?.index ?? null;
  const full = (list: PlaySub[]) => list.find((s) => !s.signs && !s.forced);
  const en = subs.filter((s) => s.lang?.toLowerCase() === "eng");
  return (full(ru) ?? full(en) ?? ru[0] ?? en[0])?.index ?? null;
}

/** Профиль устройства для PlaybackInfo: что браузер играет сам, во что перекодировать остальное. */
export function deviceProfile(caps: PlayCaps) {
  const video = ["h264", ...(caps.hevc ? ["hevc"] : []), ...(caps.av1 ? ["av1"] : [])].join(",");
  return {
    MaxStreamingBitrate: caps.maxBitrate,
    DirectPlayProfiles: [
      { Container: "mp4,m4v", Type: "Video", VideoCodec: video, AudioCodec: "aac,mp3,opus,flac" },
      { Container: "webm", Type: "Video", VideoCodec: "vp9,av1", AudioCodec: "opus" },
    ],
    // HLS fMP4: видео копируется, если браузер его умеет (HEVC 10 бит в Chrome с аппаратным декодером), звук — AAC
    TranscodingProfiles: [{
      Container: "mp4", Type: "Video", VideoCodec: video, AudioCodec: "aac", Protocol: "hls", Context: "Streaming",
      MaxAudioChannels: "2", MinSegments: 1, BreakOnNonKeyFrames: true,
    }],
    // ASS и текстовые — файлом (рисует плеер), картинки (PGS) — вжигаются в видео
    SubtitleProfiles: [
      ...["ass", "ssa", "srt", "subrip", "vtt", "webvtt"].map((Format) => ({ Format, Method: "External" })),
      { Format: "pgssub", Method: "Encode" }, { Format: "dvdsub", Method: "Encode" },
    ],
    CodecProfiles: [], ContainerProfiles: [], ResponseProfiles: [],
  };
}

/**
 * Скачанные TorrServer куски → доли файла [начало, конец) (0–1), слитые подряд идущие. Файл лежит в раздаче
 * со смещения offset байт; кусок — pieceLen байт. На время переводится пропорционально размеру (для полоски хватает).
 */
export function piecesToRanges(done: number[], pieceLen: number, offset: number, length: number): [number, number][] {
  const out: [number, number][] = [];
  for (const id of [...done].sort((a, b) => a - b)) {
    const a = Math.max(id * pieceLen, offset);
    const b = Math.min((id + 1) * pieceLen, offset + length);
    if (b <= a) continue;
    const r: [number, number] = [(a - offset) / length, (b - offset) / length];
    const last = out.at(-1);
    if (last && r[0] - last[1] < 1e-9) last[1] = r[1];
    else out.push(r);
  }
  return out;
}

/** SRT → WebVTT (браузер в <track> понимает только VTT): заголовок, запятая в миллисекундах → точка, без номеров. */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim()
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3} -->)/gm, "");
  return `WEBVTT\n\n${body}\n`;
}

// Главы из файла — обычно по-английски и по-японски: Intro, OP, Part A, ED, Next Episode, Avant, Eyecatch
const CHAPTER_RU: [RegExp, string][] = [
  [/^(intro|prologue|avant|cold open|アバン)$/i, "Вступление"],
  [/^(op|opening|oped|op\d*|opening \d+|オープニング)$/i, "Опенинг"],
  [/^(ed|ending|ed\d*|ending \d+|credits|エンディング)$/i, "Эндинг"],
  [/^(next( episode)?|preview|next time|to be continued|予告|次回予告)$/i, "Анонс"],
  [/^(eyecatch|eye ?catch|アイキャッチ)$/i, "Перебивка"],
  [/^(recap|previously)$/i, "Ранее"],
  [/^(epilogue|post[- ]credits?|c ?part)$/i, "После титров"],
  [/^(title|title card)$/i, "Название"],
];

/** Название главы по-русски: «Part B» → «Часть B», «Chapter 3» → «Глава 3»; неизвестное — как есть. */
export function chapterLabel(name: string): string {
  const n = name.trim();
  for (const [re, ru] of CHAPTER_RU) if (re.test(n)) return ru;
  const part = /^(?:part|パート)\s*([a-z0-9]+)$/i.exec(n);
  if (part) return `Часть ${part[1].toUpperCase()}`;
  const ch = /^chapter\s*(\d+)$/i.exec(n);
  if (ch) return `Глава ${Number(ch[1])}`;
  return n;
}

/** Досмотрел: серия отмечается просмотренной после 85% (титры и превью следующей — не обязательно). */
export const WATCHED_SHARE = 0.85;
