import "server-only";
import { db } from "../db";
import { embed, embedAvailable } from "../llm";
import { analysisFeatures, featureAffinity, normTheme, type Features } from "@/lib/analysis-features";
import { cosine } from "./math";
import { allAnalyses, type Analysis, type Profile } from "./profile";

// Признаки разбора для алгоритмов без ИИ (см. lib/analysis-features.ts) + склейка тем-синонимов.

let canonMemo: { at: number; map: Map<string, string> } | null = null;

function canonMap(): Map<string, string> {
  if (canonMemo && Date.now() - canonMemo.at < 3600_000) return canonMemo.map;
  const rows = db.prepare<[], { theme: string; canon: string }>("SELECT theme, canon FROM theme_canon").all();
  canonMemo = { at: Date.now(), map: new Map(rows.map((r) => [r.theme, r.canon])) };
  return canonMemo.map;
}

export function featuresOfAnalysis(a: Analysis): Features {
  const canon = canonMap();
  return analysisFeatures(a, (t) => canon.get(t) ?? t);
}

export function featuresOf(p: Profile | null | undefined): Features | null {
  return p?.analysis ? featuresOfAnalysis(p.analysis) : null;
}

/** Склонности пользователя по признакам разборов. Любит «так плохо, что смешно» — нелепость весит больше. */
export function userFeatureAffinity(weights: Map<number, number>, profiles: Map<number, Profile>, ironic: boolean): Features {
  const aff = featureAffinity([...weights].map(([id, weight]) => ({ weight, f: featuresOf(profiles.get(id)) })));
  const sobad = aff.get("scale:sobad");
  if (ironic && sobad !== undefined && sobad > 0) aff.set("scale:sobad", Math.min(1, sobad * 1.5));
  return aff;
}

// Порог по замеру 2026-10-26: «comedy → комедия» 0.866, «reincarnation → реинкарнация» 0.860 — склеить;
// «пародия → комедия» 0.854 — нет. Версия склейки: сменилось правило — пересчитать (данные производные, бесплатно)
const SAME = 0.858;
const CANON_V = "2";

/** Узкая тема не сливается с общей, если содержит её («dark fantasy» ≠ «fantasy»). */
const narrower = (theme: string, anchor: string) => theme !== anchor && theme.includes(anchor);
const toVec = (b: Buffer) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

/**
 * Новые темы из разборов → каноническая форма: ближайшая уже известная тема (косинус > 0.85) или сама тема.
 * Частые темы обрабатываются первыми и становятся каноническими. Фоновая задача; без эмбеддингов — пропуск.
 */
export async function updateThemeCanon(): Promise<number> {
  if (!(await embedAvailable())) return 0;
  const v = db.prepare<[], { value: string }>("SELECT value FROM app_settings WHERE key = 'theme-canon-v'").get();
  if (v?.value !== CANON_V) {
    db.exec("DELETE FROM theme_canon");
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('theme-canon-v', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(CANON_V, Math.floor(Date.now() / 1000));
  }
  const counts = new Map<string, number>();
  for (const a of allAnalyses().values()) for (const t of a.themes) {
    const n = normTheme(t);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const known = db.prepare<[], { theme: string; canon: string; embedding: Buffer | null }>("SELECT theme, canon, embedding FROM theme_canon").all();
  const have = new Set(known.map((k) => k.theme));
  // Опорные — канонические темы со своими векторами
  const anchors = known.filter((k) => k.theme === k.canon && k.embedding).map((k) => ({ theme: k.theme, v: toVec(k.embedding!) }));
  const fresh = [...counts].filter(([t]) => !have.has(t)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const put = db.prepare("INSERT INTO theme_canon (theme, canon, embedding) VALUES (?, ?, ?) ON CONFLICT (theme) DO UPDATE SET canon = excluded.canon, embedding = excluded.embedding");
  for (let i = 0; i < fresh.length; i += 64) {
    const batch = fresh.slice(i, i + 64);
    const vecs = await embed(batch);
    batch.forEach((theme, n) => {
      const v = vecs[n];
      let best: { theme: string; sim: number } | null = null;
      for (const a of anchors) {
        const sim = cosine(v, a.v);
        if (sim > SAME && !narrower(theme, a.theme) && (!best || sim > best.sim)) best = { theme: a.theme, sim };
      }
      const canon = best?.theme ?? theme;
      if (!best) anchors.push({ theme, v });
      put.run(theme, canon, Buffer.from(new Float32Array(v).buffer));
    });
  }
  canonMemo = null;
  return fresh.length;
}
