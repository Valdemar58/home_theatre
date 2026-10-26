// Пересказ сезона (plot_deep): чистые правила — порции серий и состояние «на момент серии k».
// Модель идёт по сезону слепо по порядку: каждая порция видит только прошлое состояние и свои серии,
// поэтому состояние после порции не знает ничего дальше её последней серии.

export type DeepCharacter = { name_ru: string; name_en: string; name_ja: string; role_ru: string };
export type DeepTerm = { term: string; ru: string; kind: string };
export type DeepArc = { name_ru: string; eps: string; status: string; summary_ru: string };

/** Состояние сезона после серии upTo; beats — краткое содержание серий этой порции. */
export type DeepState = {
  upTo: number;
  retelling_ru: string;
  ending_state_ru: string;
  arcs: DeepArc[];
  characters: DeepCharacter[];
  glossary: DeepTerm[];
  beats: Record<number, string>;
};

export type BatchEp = { ep: number; chars: number };

/**
 * Порции по порядку серий: не больше maxEps серий и maxChars текста (серия длиннее — одна в порции).
 * Нарезка всегда от первой серии — новая серия онгоинга меняет только последнюю порцию.
 */
export function planBatches(eps: BatchEp[], maxEps = 4, maxChars = 30_000): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let size = 0;
  for (const e of [...eps].sort((a, b) => a.ep - b.ep)) {
    if (cur.length && (cur.length >= maxEps || size + e.chars > maxChars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e.ep);
    size += e.chars;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Что можно показать досмотревшему до серии k: состояние последней порции, целиком лежащей в 1..k,
 * и краткое содержание серий ≤ k (из следующей порции — только свои серии).
 */
export function stateAt(states: DeepState[], k: number): { state: DeepState | null; beats: Record<number, string> } {
  const sorted = [...states].sort((a, b) => a.upTo - b.upTo);
  const state = sorted.filter((s) => s.upTo <= k).at(-1) ?? null;
  const beats: Record<number, string> = {};
  for (const s of sorted) for (const [ep, text] of Object.entries(s.beats)) if (Number(ep) <= k) beats[Number(ep)] = text;
  return { state, beats };
}

/** Термины и имена сезона — в словарь перевода (как имена персонажей Shikimori). */
export function deepGlossary(s: Pick<DeepState, "characters" | "glossary">): { names: string[]; ru: string }[] {
  return [
    ...s.characters.map((c) => ({ names: [c.name_en, c.name_ja].map((x) => x.trim()).filter(Boolean), ru: c.name_ru.trim() })),
    ...s.glossary.map((t) => ({ names: [t.term.trim()].filter(Boolean), ru: t.ru.trim() })),
  ].filter((x) => x.names.length && x.ru);
}
