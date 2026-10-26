// Баллы озвучек/студий из profiles.toml — те же правила, по которым выбирает Sonarr.
// Формат файла простой ([[general]] / [[anime]] с name/regex/score), поэтому без библиотеки TOML.
import fs from "node:fs";

export type ScoreRule = { name: string; regex: RegExp | null; score: number };
export type Profiles = { general: ScoreRule[]; anime: ScoreRule[] };

function unquote(v: string): string {
  v = v.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1);
  return v;
}

/** .NET-регулярки Sonarr почти совместимы с JS; несовместимые правила просто пропускаем. */
function toRegex(src: string | undefined): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src, "iu");
  } catch {
    try {
      return new RegExp(src, "i");
    } catch {
      return null;
    }
  }
}

export function parseProfiles(text: string): Profiles {
  const out: Profiles = { general: [], anime: [] };
  let section: "general" | "anime" | null = null;
  let current: { name?: string; regex?: string; score?: number } | null = null;
  const flush = () => {
    if (section && current?.name && current.score !== undefined) {
      out[section].push({ name: current.name, regex: toRegex(current.regex), score: current.score });
    }
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[\[(general|anime)\]\]$/);
    if (header) {
      flush();
      section = header[1] as "general" | "anime";
      current = {};
      continue;
    }
    if (line.startsWith("[")) {
      flush();
      section = null;
      continue;
    }
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv || !current) continue;
    if (kv[1] === "name") current.name = unquote(kv[2]);
    else if (kv[1] === "regex") current.regex = unquote(kv[2]);
    else if (kv[1] === "score") current.score = Number(kv[2]);
  }
  flush();
  // Правила без regex в [[anime]] ссылаются на одноимённое правило из [[general]]
  for (const r of out.anime) if (!r.regex) r.regex = out.general.find((g) => g.name === r.name)?.regex ?? null;
  return out;
}

let loaded: { profiles: Profiles; mtime: number } | null = null;

export function loadProfiles(path = process.env.PROFILES_PATH ?? "/profiles.toml"): Profiles {
  try {
    const mtime = fs.statSync(path).mtimeMs;
    if (!loaded || loaded.mtime !== mtime) loaded = { profiles: parseProfiles(fs.readFileSync(path, "utf-8")), mtime };
    return loaded.profiles;
  } catch {
    return { general: [], anime: [] };
  }
}

/** Сумма баллов и сработавшие правила для названия раздачи. */
export function scoreTitle(title: string, rules: ScoreRule[]): { score: number; matched: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const r of rules) {
    if (r.regex?.test(title)) {
      score += r.score;
      matched.push(r.name);
    }
  }
  return { score, matched };
}
