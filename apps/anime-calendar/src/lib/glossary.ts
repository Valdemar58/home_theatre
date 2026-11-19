import type { GlossaryEntry } from "./translate-text";

// Единый глоссарий франшизы (TASKS 5.6): имена, места и термины — одинаково в субтитрах, надписях, пересказах и книгах.
// Термин собирается из источников (персонажи Shikimori аниме и манги, граф сюжета, пересказ сезона, ИИ при переводе);
// ручная правка главнее всех и при пересборке не трогается.

export type TermKind = "name" | "place" | "term" | "skill" | "title";
export const TERM_KINDS: Record<TermKind, string> = { name: "Имя", place: "Место", term: "Термин", skill: "Навык", title: "Название" };
export type TermSource = "manual" | "shikimori" | "plot" | "deep" | "ai";
export const TERM_SOURCES: Record<TermSource, string> = { manual: "вручную", shikimori: "Shikimori", plot: "граф сюжета", deep: "пересказ", ai: "ИИ" };
/** Чем выше, тем главнее русский вариант источника */
const RANK: Record<TermSource, number> = { manual: 4, shikimori: 3, plot: 2, deep: 1, ai: 0 };

export type Term = {
  id?: number;
  kind: TermKind;
  ja: string | null;
  en: string | null;
  ru: string;
  alts: string[];
  note: string | null;
  source: TermSource;
  /** Закреплён: сборка не меняет (ручная правка закрепляет сама) */
  locked: boolean;
  /** Предложено ИИ — ждёт проверки, в перевод не идёт */
  proposed: boolean;
  /** Убран вручную: сборка его узнаёт и не возвращает, в перевод не идёт */
  hidden?: boolean;
};

export const termKey = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s・=＝·.,'"«»()-]+/g, "");

/** Все написания термина (кроме русского) — по ним ищется в тексте и склеиваются источники. */
export const termNames = (t: Pick<Term, "ja" | "en" | "alts">) => [t.en, t.ja, ...t.alts].filter((x): x is string => Boolean(x?.trim()));

const same = (a: Pick<Term, "ja" | "en" | "alts">, b: Pick<Term, "ja" | "en" | "alts">) => {
  const keys = new Set(termNames(a).map(termKey).filter((k) => k.length > 1));
  return termNames(b).some((n) => keys.has(termKey(n)));
};

const uniq = (xs: string[], skip: (string | null)[]) => {
  const seen = new Set(skip.map(termKey));
  return xs.filter((x) => {
    const k = termKey(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Влить найденные термины в глоссарий: тот же термин (совпало любое написание) — дополнить пустое и варианты;
 * русский меняет только источник главнее; закреплённое не трогается. Возвращает новый список и сколько изменено.
 */
export type FoundTerm = Omit<Term, "id" | "locked" | "proposed" | "note" | "hidden">;

export function mergeTerms(current: Term[], incoming: FoundTerm[]): { terms: Term[]; added: number; changed: number } {
  const terms = current.map((t) => ({ ...t, alts: [...t.alts] }));
  let added = 0, changed = 0;
  for (const inc of incoming) {
    if (!inc.ru.trim() || !termNames(inc).length) continue;
    const t = terms.find((x) => same(x, inc));
    if (!t) {
      terms.push({ ...inc, ru: inc.ru.trim(), alts: uniq(inc.alts, [inc.en, inc.ja]), note: null, locked: false, proposed: inc.source === "ai" });
      added++;
      continue;
    }
    if (t.locked || t.hidden) continue;
    const before = JSON.stringify(t);
    t.ja ??= inc.ja;
    t.en ??= inc.en;
    t.alts = uniq([...t.alts, ...termNames(inc)], [t.en, t.ja]);
    if (RANK[inc.source] > RANK[t.source]) {
      t.ru = inc.ru.trim();
      t.source = inc.source;
      t.proposed = false;
      if (inc.kind !== "term") t.kind = inc.kind;
    }
    if (JSON.stringify(t) !== before) changed++;
  }
  return { terms, added, changed };
}

/** Глоссарий → словарь перевода: закреплённое и ручное первыми, предложенное ИИ — не идёт. */
export function glossaryEntries(terms: Term[]): GlossaryEntry[] {
  return terms.filter((t) => !t.proposed && !t.hidden)
    .sort((a, b) => Number(b.locked) - Number(a.locked) || RANK[b.source] - RANK[a.source])
    .map((t) => ({ names: termNames(t), ru: t.ru }));
}

/** Словарь глоссария + прежний (Shikimori одного тайтла, пересказ): у прежнего — только то, чего в глоссарии нет. */
export function withFallback(glossary: GlossaryEntry[], fallback: GlossaryEntry[]): GlossaryEntry[] {
  const keys = new Set(glossary.flatMap((g) => g.names.map(termKey)));
  return [...glossary, ...fallback.filter((f) => !f.names.some((n) => keys.has(termKey(n))))];
}
