import "server-only";
import { glossaryEntries, mergeTerms, termNames, withFallback, type FoundTerm, type Term, type TermKind } from "@/lib/glossary";
import { deepGlossary } from "@/lib/plot-deep";
import { displayTitle } from "@/lib/schedule";
import type { GlossaryEntry } from "@/lib/translate-text";
import { bookDetails, booksForAnime } from "./books/anilist-books";
import { bookCharacterGlossary, characterGlossary } from "./characters";
import { db, now } from "./db";
import { franchiseGraph } from "./franchise";
import { seasonPlot } from "./plot-deep";

// Единый глоссарий франшизы (TASKS 5.6). Корень — франшиза аниме; у книги — франшиза её экранизации, без экранизации —
// сама книга (id AniList у аниме и книг из одного пространства). Сборка — из персонажей Shikimori (аниме и манга),
// графа сюжета и пересказа сезона; ручная правка закрепляет термин. Перевод (серии, надписи, кадр, главы) берёт
// словарь глоссария первым, а прежний словарь тайтла — только то, чего в глоссарии нет.

export type GlossaryRef = { anime: number } | { book: number };
const ROOT_TTL = 7 * 86400;

/** Корень глоссария для тайтла или книги (запомненный — сразу, раз в неделю перепроверяется). */
export async function glossaryRoot(ref: GlossaryRef): Promise<number> {
  const [id, type] = "anime" in ref ? [ref.anime, "anime"] : [ref.book, "book"];
  const known = db.prepare<[number, string], { root_id: number; checked_at: number }>(
    "SELECT root_id, checked_at FROM glossary_root WHERE media_id = ? AND type = ?").get(id, type);
  if (known && now() - known.checked_at < ROOT_TTL) return known.root_id;
  let root = id;
  let title: string | null = null;
  try {
    if (type === "anime") {
      const g = await franchiseGraph(id);
      root = g.root;
      const r = g.items.find((i) => i.media.id === root)?.media;
      title = r ? displayTitle(r.title) : null;
    } else {
      const b = await bookDetails(id);
      // Экранизация — глоссарий её франшизы (имена в субтитрах и в книге одни)
      const anime = b.relations.find((r) => r.type === "ANIME" && r.relationType === "ADAPTATION");
      if (anime) return glossaryRoot({ anime: anime.id }).then((r) => (save(r), r));
      title = b.title.ru || b.title.romaji;
    }
  } catch (e) {
    if (known) return known.root_id;
    throw e;
  }
  save(root);
  if (title) db.prepare("INSERT INTO glossary_meta (root_id, title) VALUES (?, ?) ON CONFLICT (root_id) DO UPDATE SET title = excluded.title").run(root, title);
  return root;
  function save(r: number) {
    db.prepare("INSERT INTO glossary_root (media_id, type, root_id, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (media_id, type) DO UPDATE SET root_id = excluded.root_id, checked_at = excluded.checked_at")
      .run(id, type, r, now());
  }
}

type Row = { id: number; kind: TermKind; ja: string | null; en: string | null; ru: string; alts: string; note: string | null; source: Term["source"]; locked: number; proposed: number; hidden: number };
const toTerm = (r: Row): Term => ({ id: r.id, kind: r.kind, ja: r.ja, en: r.en, ru: r.ru, alts: JSON.parse(r.alts) as string[], note: r.note, source: r.source, locked: Boolean(r.locked), proposed: Boolean(r.proposed), hidden: Boolean(r.hidden) });

export const loadTerms = (root: number): Term[] =>
  db.prepare<[number], Row>("SELECT * FROM glossary_term WHERE root_id = ?").all(root).map(toTerm)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.ru.localeCompare(b.ru, "ru"));

/** Записать слитый список: новые — вставить, изменённые — обновить. */
function storeTerms(root: number, before: Term[], after: Term[]) {
  const was = new Map(before.filter((t) => t.id).map((t) => [t.id!, JSON.stringify(t)]));
  const t = now();
  const ins = db.prepare(`INSERT INTO glossary_term (root_id, kind, ja, en, ru, alts, note, source, locked, proposed, hidden, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE glossary_term SET kind = ?, ja = ?, en = ?, ru = ?, alts = ?, note = ?, source = ?, locked = ?, proposed = ?, hidden = ?, updated_at = ? WHERE id = ?`);
  db.transaction(() => {
    for (const x of after) {
      const vals = [x.kind, x.ja, x.en, x.ru, JSON.stringify(x.alts), x.note, x.source, Number(x.locked), Number(x.proposed), Number(Boolean(x.hidden)), t] as const;
      if (!x.id) ins.run(root, ...vals);
      else if (was.get(x.id) !== JSON.stringify(x)) upd.run(...vals, x.id);
    }
  })();
}

/** Влить найденные термины в глоссарий корня (так же — предложения ИИ при переводе). */
export function addFound(root: number, found: FoundTerm[]) {
  const cur = loadTerms(root);
  const { terms, added, changed } = mergeTerms(cur, found);
  storeTerms(root, cur, terms);
  return { added, changed };
}

const fromEntries = (xs: GlossaryEntry[], kind: TermKind, source: FoundTerm["source"]): FoundTerm[] => xs.map((e) => {
  const ja = e.names.find((n) => /[぀-ヿ一-鿿]/.test(n)) ?? null;
  const en = e.names.find((n) => n !== ja) ?? null;
  return { kind, ja, en, ru: e.ru, alts: e.names.filter((n) => n !== ja && n !== en), source };
});

const PLOT_KIND: Record<string, TermKind> = { character: "name", place: "place", group: "term" };

/** Собрать глоссарий корня из источников. */
async function collect(root: number): Promise<{ added: number; changed: number }> {
  const found: FoundTerm[] = [];
  const anime: { id: number; idMal: number | null }[] = [];
  const books = new Map<number, number | null>();
  const asAnime = db.prepare<[number], { x: number }>("SELECT 1 x FROM glossary_root WHERE root_id = ? AND type = 'anime' LIMIT 1").get(root);
  if (asAnime) {
    const g = await franchiseGraph(root);
    for (const i of g.items) anime.push({ id: i.media.id, idMal: i.media.idMal ?? null });
    // Первоисточник и манга по основной истории
    for (const i of g.items.filter((x) => x.kind === "main").slice(0, 12)) {
      for (const b of await booksForAnime(i.media.id).catch(() => [])) books.set(b.id, null);
    }
  } else {
    const b = await bookDetails(root);
    books.set(b.id, b.idMal);
  }
  for (const a of anime) found.push(...fromEntries(await characterGlossary(a.idMal).catch(() => []), "name", "shikimori"));
  for (const [id, mal] of books) {
    const idMal = mal ?? (await bookDetails(id).catch(() => null))?.idMal ?? null;
    found.push(...fromEntries(await bookCharacterGlossary(idMal).catch(() => []), "name", "shikimori"));
  }
  const ids = anime.map((a) => a.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const ents = db.prepare<number[], { id: number; kind: string; name: string; name_ru: string | null; name_ja: string | null }>(
      `SELECT DISTINCT e.id, e.kind, e.name, e.name_ru, e.name_ja FROM plot_entity e JOIN plot_appearance a ON a.entity_id = e.id
       WHERE a.anilist_id IN (${marks}) AND e.name_ru IS NOT NULL`).all(...ids);
    const aliases = db.prepare<[number], { alias: string }>("SELECT DISTINCT alias FROM plot_alias WHERE entity_id = ? AND (lang IS NULL OR lang != 'ru')");
    for (const e of ents) {
      found.push({ kind: PLOT_KIND[e.kind] ?? "term", en: e.name, ja: e.name_ja, ru: e.name_ru!, alts: aliases.all(e.id).map((x) => x.alias), source: "plot" });
    }
    for (const id of ids) {
      const s = seasonPlot(id)?.state;
      if (!s) continue;
      found.push(...fromEntries(deepGlossary({ characters: s.characters, glossary: [] }), "name", "deep"));
      found.push(...fromEntries(deepGlossary({ characters: [], glossary: s.glossary }), "term", "deep"));
    }
  }
  const res = addFound(root, found);
  db.prepare("INSERT INTO glossary_meta (root_id, collected_at) VALUES (?, ?) ON CONFLICT (root_id) DO UPDATE SET collected_at = excluded.collected_at").run(root, now());
  return res;
}

const g = globalThis as unknown as { __glossaryCollect?: Map<number, Promise<{ added: number; changed: number }>> };
const running: Map<number, Promise<{ added: number; changed: number }>> = (g.__glossaryCollect ??= new Map());

/** Собрать в фоне (одна сборка на корень). */
export function collectGlossary(root: number) {
  const cur = running.get(root);
  if (cur) return cur;
  const job = collect(root).finally(() => running.delete(root));
  running.set(root, job);
  return job;
}
export const isCollecting = (root: number) => running.has(root);

export function glossaryMeta(root: number) {
  const m = db.prepare<[number], { title: string | null; collected_at: number | null }>("SELECT title, collected_at FROM glossary_meta WHERE root_id = ?").get(root);
  return { root, title: m?.title ?? null, collectedAt: m?.collected_at ?? null, collecting: isCollecting(root) };
}

/**
 * Словарь для перевода: глоссарий франшизы первым, дальше прежний словарь (без того, что есть в глоссарии).
 * Глоссарий ни разу не собирался — собрать в фоне (этот перевод обойдётся прежним).
 */
export async function franchiseGlossary(ref: GlossaryRef, fallback: GlossaryEntry[] = []): Promise<GlossaryEntry[]> {
  try {
    const root = await glossaryRoot(ref);
    if (!glossaryMeta(root).collectedAt && !isCollecting(root)) void collectGlossary(root).catch((e) => console.warn(`[glossary] ${root}: ${String(e)}`));
    return withFallback(glossaryEntries(loadTerms(root)), fallback);
  } catch {
    return fallback;
  }
}

/** Короткий список закреплённых и главных имён — для подсказки модели со зрением (кадр). */
export async function glossaryHint(ref: GlossaryRef, limit = 20): Promise<string[]> {
  const entries = await franchiseGlossary(ref);
  return entries.slice(0, limit).map((e) => `${e.names[0]} = ${e.ru}`);
}

// ---------------------------------------------------------------- правка (редактор)

export type TermPatch = Partial<Pick<Term, "kind" | "ja" | "en" | "ru" | "alts" | "note" | "locked" | "hidden">>;

/** Ручная правка: термин становится ручным и закреплённым (сборка его больше не меняет). */
export function editTerm(root: number, id: number, patch: TermPatch) {
  const cur = loadTerms(root);
  const t = cur.find((x) => x.id === id);
  if (!t) return false;
  const next: Term = { ...t, ...patch, alts: patch.alts ?? t.alts, source: patch.hidden !== undefined && Object.keys(patch).length === 1 ? t.source : "manual",
    locked: patch.locked ?? (patch.hidden !== undefined && Object.keys(patch).length === 1 ? t.locked : true), proposed: false };
  storeTerms(root, cur, cur.map((x) => (x.id === id ? next : x)));
  return true;
}

export function addTerm(root: number, t: Pick<Term, "kind" | "ja" | "en" | "ru" | "alts" | "note">) {
  if (!t.ru.trim() || !termNames(t).length) throw new Error("Нужны русское написание и хотя бы одно исходное");
  const cur = loadTerms(root);
  storeTerms(root, cur, [...cur, { ...t, ru: t.ru.trim(), source: "manual", locked: true, proposed: false, hidden: false }]);
}
