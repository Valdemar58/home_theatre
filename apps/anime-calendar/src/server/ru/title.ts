// Название раздачи в виде, который понимает парсер Sonarr:
//   That Time I Got Reincarnated as a Slime S02E13-24 [BluRay 1080p] [RUS(ext), JAP] AniLibria RUS
// Модуль чистый, чтобы его можно было тестировать.
import type { ParsedRelease } from "./parse";

export type EpisodeRefLike =
  | { kind: "season"; season: number; from: number; to: number; full: boolean }
  | { kind: "absolute"; from: number; to: number };

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** Токен качества в терминах Sonarr. Разрешение, если не указано, для новых тайтлов считаем 1080p. */
export function qualityToken(p: Pick<ParsedRelease, "source" | "resolution" | "year">): string {
  const res = p.resolution ?? (p.year && p.year >= 2012 ? "1080p" : "720p");
  switch (p.source) {
    case "BDRemux": return `BluRay ${res} REMUX`;
    case "BDRip": return `BluRay ${res}`;
    case "WEB-DL": return `WEB-DL ${res}`;
    case "WEBRip": return `WEBRip ${res}`;
    case "HDTVRip": return `HDTV ${res}`;
    case "DVDRip": return "DVDRip";
    case "TVRip": return "SDTV";
    default: return `WEB-DL ${res}`;
  }
}

function episodesToken(ref: EpisodeRefLike): string {
  if (ref.kind === "absolute") {
    return ref.from === ref.to ? `- ${pad(ref.from, 3)}` : `- ${pad(ref.from, 3)}-${pad(ref.to, 3)}`;
  }
  if (ref.full) return `S${pad(ref.season)}`;
  return ref.from === ref.to ? `S${pad(ref.season)}E${pad(ref.from)}` : `S${pad(ref.season)}E${pad(ref.from)}-${pad(ref.to)}`;
}

function audioToken(p: ParsedRelease): string {
  const langs = p.audio.langs.map((l) =>
    l === "RUS" && (p.audio.rus === "int" || p.audio.rus === "ext") ? `RUS(${p.audio.rus})` : l);
  if (!langs.length && p.audio.rus) langs.push("RUS");
  return langs.length ? `[${langs.join(", ")}]` : "";
}

export function sonarrTitle(seriesTitle: string, ref: EpisodeRefLike, p: ParsedRelease, voices: string[] = []): string {
  const parts = [
    seriesTitle.replace(/[[\]]/g, ""),
    episodesToken(ref),
    `[${qualityToken(p)}${p.hdr ? " HDR" : ""}]`,
    audioToken(p),
    // Студии через запятую: по ним срабатывают форматы озвучки из profiles.toml
    [...new Set([...p.audio.kinds, ...p.voices, ...voices])].join(", "),
    // По «RUS» Sonarr определяет язык, а наши форматы — русскую дорожку
    p.audio.rus ? "RUS" : "",
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
