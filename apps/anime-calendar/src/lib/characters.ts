import type { GlossaryEntry } from "./translate-text";

// Русские имена персонажей AniList по словарю Shikimori тайтла.

// «Tempest Rimuru» и «Rimuru Tempest» — одно имя: сравниваем набор слов
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).sort().join(" ");

/** Русское имя: совпало английское (в любом порядке слов, без знаков) или японское имя. */
export function ruNameOf(glossary: GlossaryEntry[], name: string, native: string | null): string | null {
  const key = nameKey(name);
  const hit = glossary.find((g) => g.names.some((n) => nameKey(n) === key || (native !== null && n === native)));
  return hit?.ru ?? null;
}
