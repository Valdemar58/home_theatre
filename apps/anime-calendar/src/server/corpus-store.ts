import "server-only";
import { db, now } from "./db";
import { hashOf } from "./knowledge";

// Хранилище корпуса сюжета (таблица episode_text): тексты о сериях без срока жизни.
// Изменился текст — новая строка, текущая — последняя неотозванная по (серия, источник).

export type Depth = "teaser" | "full" | "script";
export type CorpusText = { ep: number; source: string; lang: string; depth: Depth; title: string | null; text: string; url: string | null; fetchedAt: number };
/** aired — дата выхода серии по источнику (YYYY-MM-DD): по ней проверяется сопоставление серий с AniList */
/** depth — своя у строки (у MAL описание бывает и анонсом, и пересказом); пустой text — серия только для сверки, не записывается */
export type Found = { ep: number; title: string | null; text: string; url: string | null; lang?: string; aired?: string | null; titleJa?: string | null; depth?: Depth; filler?: boolean };

/** Записать тексты источника; возвращает, сколько добавилось новых (тот же текст — не дублируется). */
export function putTexts(anilistId: number, source: string, lang: string, depth: Depth, license: string | null, found: Found[]): number {
  // Тот же текст — не дублируется; у записанных раньше без даты дата дописывается
  const ins = db.prepare(`INSERT INTO episode_text (anilist_id, ep, source, lang, depth, title, text, url, license, hash, fetched_at, aired, title_ja)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (anilist_id, ep, source, hash) DO UPDATE SET aired = COALESCE(episode_text.aired, excluded.aired), title_ja = COALESCE(episode_text.title_ja, excluded.title_ja)
      WHERE (episode_text.aired IS NULL AND excluded.aired IS NOT NULL) OR (episode_text.title_ja IS NULL AND excluded.title_ja IS NOT NULL)`);
  let added = 0;
  for (const f of found) {
    const text = f.text.trim();
    if (!text) continue;
    added += Number(ins.run(anilistId, f.ep, source, f.lang ?? lang, f.depth ?? depth, f.title, text, f.url, license, hashOf(text), now(), f.aired ?? null, f.titleJa ?? null).changes);
  }
  // Свежий набор источника заменяет прежний: строки, которых в нём нет (другой номер серии, старый текст), — отозваны.
  // Снова пришедший текст возвращается в текущие
  if (found.some((f) => f.text.trim())) {
    const keep = new Set(found.filter((f) => f.text.trim()).map((f) => `${f.ep}:${hashOf(f.text.trim())}`));
    const rows = db.prepare<[number, string], { id: number; ep: number; hash: string; retracted_at: number | null }>(
      "SELECT id, ep, hash, retracted_at FROM episode_text WHERE anilist_id = ? AND source = ?").all(anilistId, source);
    const set = db.prepare("UPDATE episode_text SET retracted_at = ? WHERE id = ?");
    for (const r of rows) {
      const live = keep.has(`${r.ep}:${r.hash}`);
      if (live && r.retracted_at !== null) set.run(null, r.id);
      if (!live && r.retracted_at === null) set.run(now(), r.id);
    }
  }
  return added;
}

/** Справочник серий источника (даты, названия) — заменяет прежний; пустой набор ничего не стирает (сбой сети). */
export function putMeta(anilistId: number, source: string, found: Found[]) {
  if (!found.length) return;
  db.prepare("DELETE FROM episode_meta WHERE anilist_id = ? AND source = ?").run(anilistId, source);
  const ins = db.prepare("INSERT INTO episode_meta (anilist_id, ep, source, aired, title, title_ja, filler) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (anilist_id, ep, source) DO UPDATE SET aired = excluded.aired, title = excluded.title, title_ja = excluded.title_ja, filler = excluded.filler");
  for (const f of found) ins.run(anilistId, f.ep, source, f.aired ?? null, f.title, f.titleJa ?? null, f.filler === undefined ? null : Number(f.filler));
}

/** Отозвать все тексты источника по тайтлу (TMDB оказался другим сезоном). */
export function retractSource(anilistId: number, source: string) {
  db.prepare("UPDATE episode_text SET retracted_at = ? WHERE anilist_id = ? AND source = ? AND retracted_at IS NULL").run(now(), anilistId, source);
}

type TextRow = { ep: number; source: string; lang: string; depth: Depth; title: string | null; text: string; url: string | null; fetched_at: number };

/** Текущие тексты корпуса: последняя версия по каждой (серия, источник). upTo — только серии до N (без спойлеров). */
export function corpusOf(anilistId: number, upTo?: number): CorpusText[] {
  return db.prepare<[number, number], TextRow>(
    `SELECT ep, source, lang, depth, title, text, url, fetched_at FROM episode_text t
     WHERE anilist_id = ? AND ep <= ? AND retracted_at IS NULL
       AND id = (SELECT MAX(id) FROM episode_text x WHERE x.anilist_id = t.anilist_id AND x.ep = t.ep AND x.source = t.source AND x.retracted_at IS NULL)
     ORDER BY ep, source`).all(anilistId, upTo ?? 1e9)
    .map((r) => ({ ep: r.ep, source: r.source, lang: r.lang, depth: r.depth, title: r.title, text: r.text, url: r.url, fetchedAt: r.fetched_at }));
}

const DEPTH_RANK: Record<Depth, number> = { teaser: 0, full: 1, script: 2 };

/** Самый подробный текст по каждой серии (для пересказов ИИ). */
export function deepestByEpisode(texts: CorpusText[]): Map<number, CorpusText> {
  const best = new Map<number, CorpusText>();
  for (const t of texts) {
    const cur = best.get(t.ep);
    if (!cur || DEPTH_RANK[t.depth] > DEPTH_RANK[cur.depth] || (t.depth === cur.depth && t.text.length > cur.text.length)) best.set(t.ep, t);
  }
  return best;
}
