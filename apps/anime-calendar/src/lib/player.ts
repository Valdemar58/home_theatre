// Плеер календаря: что отдаёт сервер и правила выбора дорожек (без сети — для сервера, клиента и тестов).
// Поток — Jellyfin (HLS через прокси календаря, ключ Jellyfin в браузер не попадает).

export type PlayTrack = { index: number; label: string; lang: string | null; codec: string; title: string | null };
export type PlaySub = PlayTrack & { url: string; ass: boolean; forced: boolean; signs: boolean; external: boolean };
export type PlayChapter = { name: string; start: number };

export type PlayInfo = {
  sid: string;
  /** Плейлист HLS (или файл целиком, если браузер играет его сам) */
  src: string;
  hls: boolean;
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
  /** Почему Jellyfin перекодирует (пусто — видео как есть) */
  transcode: string[];
};

/** Что умеет браузер: сервер собирает по этому профиль устройства для Jellyfin. */
export type PlayCaps = { hevc: boolean; av1: boolean; maxBitrate: number };

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

/** Досмотрел: серия отмечается просмотренной после 85% (титры и превью следующей — не обязательно). */
export const WATCHED_SHARE = 0.85;
