// Разбор названий раздач «как на Nyaa» (IDEAS #88): оригинал, английские и мультиязычные релизы.
// Типичный вид:
//   [SubsPlease] Tensei Shitara Slime Datta Ken S3 - 05 (1080p) [A1B2C3D4].mkv
//   [Erai-raws] Kusuriya no Hitorigoto 2nd Season - 01 ~ 12 [1080p CR WEB-DL AVC AAC][MultiSub]
//   [Moozzi2] Tensei Shitara Slime Datta Ken [BDRip HEVC FLAC]
//   Frieren Beyond Journey's End S01 1080p BluRay x265 Dual Audio [Group]
// Модуль чистый (без серверных зависимостей) — результат того же вида, что у русских раздач (parse.ts).

import { seasonFromName, type ParsedRelease } from "./parse";

export type SceneRelease = ParsedRelease & {
  /** Группа релиза: [SubsPlease], [Erai-raws] */
  group: string | null;
  /** Субтитры: ENG, RUS, MULTI (много языков) */
  subs: string[];
};

const NON_VIDEO = /\b(OST|Soundtrack|Original Sound ?track|FLAC 24bit|Artbook|Manga|Light Novel|Volume \d+ \(Digital\)|EPUB|CBZ|CBR|PDF)\b/i;

const SOURCES: [RegExp, string][] = [
  [/\bRemux\b/i, "BDRemux"],
  [/\bBD-?Rip\b|\bBlu-?Ray\b|\bBDMV\b|\bBD\b/i, "BDRip"],
  [/\bWEB-?DL\b|\bWEB\b|\b(?:CR|AMZN|NF|DSNP|HIDI|ADN|B-Global|Baha)\b/i, "WEB-DL"],
  [/\bWEB-?Rip\b/i, "WEBRip"],
  [/\bHDTV\b|\bTV-?Rip\b/i, "HDTVRip"],
  [/\bDVD-?Rip\b|\bDVD\b/i, "DVDRip"],
];

/** Все скобки [..] и (..) — как метки; содержимое без скобок — заголовок. */
function tags(title: string): { head: string; tags: string[] } {
  const found: string[] = [];
  const head = title.replace(/\[([^\]]*)\]|\(([^)]*)\)|【([^】]*)】/g, (_, a, b, c) => {
    found.push((a ?? b ?? c ?? "").trim());
    return " ";
  });
  return { head: head.replace(/\s+/g, " ").trim(), tags: found };
}

export function parseScene(raw: string): SceneRelease | null {
  const title = raw.replace(/\.(mkv|mp4|avi|torrent)$/i, "").replace(/_/g, " ").trim();
  if (NON_VIDEO.test(title)) return null;
  const out: SceneRelease = {
    names: [], season: null, part: null, kind: "Unknown", episodes: null, total: null, complete: false,
    audio: { rus: null, langs: [], kinds: [] }, voices: [], year: null, source: null, resolution: null, hdr: false,
    group: null, subs: [],
  };
  const group = title.match(/^\s*[[(]([^\])]+)[\])]/);
  if (group && !/^\d{3,4}p$|^\d{4}$/i.test(group[1].trim())) out.group = group[1].trim();
  const all = title;
  const { head, tags: t } = tags(title);
  const meta = `${t.join(" ")} ${head}`;

  // Серии: «- 05», «- 05v2», «- 01 ~ 12», «01-12», «S02E05», «E05», «Batch», «Complete»
  let name = head;
  const se = head.match(/\bS(\d{1,2})E(\d{1,4})(?:\s*-\s*E?(\d{1,4}))?\b/i);
  const dash = head.match(/\s[-–]\s(\d{1,4})(?:v\d)?(?:\s*[~-]\s*(\d{1,4})(?:v\d)?)?(?:\s|$)/);
  const range = t.map((x) => x.match(/^(?:Ep?\.?\s*)?(\d{1,4})\s*[~-]\s*(\d{1,4})$/i)).find(Boolean);
  if (se) {
    out.season = Number(se[1]);
    out.episodes = { from: Number(se[2]), to: Number(se[3] ?? se[2]) };
    name = head.slice(0, se.index).trim();
  } else if (dash) {
    out.episodes = { from: Number(dash[1]), to: Number(dash[2] ?? dash[1]) };
    name = head.slice(0, dash.index).trim();
  } else if (range) {
    out.episodes = { from: Number(range[1]), to: Number(range[2]) };
  }
  // Весь сезон — только по явной пометке: «01 ~ 12» у сезона из 24 серий — не весь
  if (/\b(Batch|Complete|Season Pack)\b/i.test(all)) out.complete = true;

  // Качество, источник, кодек
  const res = meta.match(/\b(2160|1080|720|576|480)p\b/i) ?? meta.match(/\b(?:3840|1920|1280|1024|720)x(2160|1080|720|576|480)\b/);
  out.resolution = res ? `${res[1]}p` : null;
  out.source = SOURCES.find(([re]) => re.test(meta))?.[1] ?? null;
  out.hdr = /\bHDR(10)?\b|\bDoVi\b|Dolby Vision/i.test(meta);
  const year = meta.match(/\b(19[6-9]\d|20[0-4]\d)\b/);
  out.year = year ? Number(year[1]) : null;
  if (/\bMovie\b|\bGekijouban\b|\bthe Movie\b/i.test(all)) out.kind = "Movie";
  else if (/\bOVA\b|\bOAD\b|\bOADs?\b/.test(all) && !/S0*1\+|\+\s*OA[DV]/i.test(all)) out.kind = "OVA";
  else if (/\bS00E\d/i.test(all)) out.kind = "Special";
  else if (/\bONA\b/.test(all)) out.kind = "ONA";

  // Звук: по умолчанию японский; Dual Audio — японский и английский; RUS — русская дорожка
  out.audio.langs.push("JAP");
  if (/\bDual[ -]?Audio\b|\bEng(?:lish)?[ -]?Dub\b|\bDUB\b/i.test(meta)) out.audio.langs.push("ENG");
  if (/\bMulti[ -]?Audio\b/i.test(meta)) out.audio.langs.push("ENG", "MULTI");
  if (/\bRUS(?:sian)?[ -]?(?:Dub|Audio)\b/i.test(meta)) { out.audio.langs.push("RUS"); out.audio.rus = "int"; }
  // Субтитры
  if (/\bMulti[ -]?Subs?\b|\bMultiSub\b|\bMulti\b/i.test(meta)) out.subs.push("MULTI");
  if (/\bEng(?:lish)?[ -]?Subs?\b|\bENG\b/i.test(meta) || /^(SubsPlease|Erai-raws|HorribleSubs|Judas|EMBER|ASW|Tsundere-Raws|Anime Time|Yameii|ToonsHub)$/i.test(out.group ?? "")) out.subs.push("ENG");
  if (/\bRus(?:sian)?[ -]?Subs?\b|\bRUS[ -]?SUB\b/i.test(meta)) out.subs.push("RUS");
  // Erai-raws — субтитры на многих языках, русские среди них
  if (/^Erai-raws$/i.test(out.group ?? "") && out.subs.includes("MULTI")) out.subs.push("RUS");
  if (/\bRAW\b/.test(meta) && !out.subs.length) out.subs.push("нет");
  out.subs = [...new Set(out.subs)];
  out.audio.langs = [...new Set(out.audio.langs)];

  // Названия: «Romaji | English», «Romaji / English»; без года, сезона и служебных слов
  name = name.replace(/^\s*[[(][^\])]+[\])]\s*/, "")
    .replace(/\b(Batch|Complete|Season Pack|Dual[ -]?Audio|Multi[ -]?(Audio|Subs?)|1080p|720p|2160p|BluRay|Blu-ray|BDRip|WEB-?DL|WEB-?Rip|x26[45]|HEVC|AVC|AV1|FLAC|AAC|OPUS|10-?bit)\b.*$/i, "")
    .replace(/\s\b(19[6-9]\d|20[0-4]\d)\b.*$/, "").trim();
  for (const seg of name.split(/\s+[|/]\s+/)) {
    const s = seg.replace(/\s*[-–:]\s*$/, "").trim();
    if (!s) continue;
    const sn = seasonFromName(s);
    out.season ??= sn.season;
    out.part ??= sn.part;
    const bare = s.replace(/\s+S\d{1,2}$/i, "").replace(/\s+Season\s+\d+$/i, "").trim();
    out.names.push(s);
    if (bare !== s) out.names.push(bare);
  }
  // Сезон в скобках: «(Season 2)», «[S2]», «(Season 3 + Special)», «(Season 2 Part 02 + Special)»
  for (const x of t) {
    if (out.season !== null) break;
    const m = x.match(/\bSeason\s*(\d{1,2})\b/i) ?? x.match(/^S(\d{1,2})$/i) ?? x.match(/\b(\d)(?:st|nd|rd|th)\s+Season\b/i);
    if (m) {
      out.season = Number(m[1]);
      out.part ??= Number(x.match(/\bPart\s*0?(\d)\b/i)?.[1]) || null;
    }
  }
  if (!out.names.length) return null;
  return out;
}
