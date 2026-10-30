// Что из книги адаптирует сезон аниме (TASKS 5.10): «тома 1–4 ранобэ», «главы 1–38 манги». Источник — инфобоксы
// серий на Fandom (поле adaptation / chapters / volume), ручная правка важнее. Чистые функции — для тестов.

export type AdaptForm = "novel" | "manga";
export type AdaptUnit = "vol" | "ch";
export type AdaptRange = { form: AdaptForm; unit: AdaptUnit; from: number; to: number; source: "fandom" | "manual" };

const FIELD = /adapt|chapter|volume|source|manga|novel/;

/** Поля инфобокса вики-разметки: «|ключ = значение» (ключи — в нижнем регистре). */
function fields(wikitext: string): [string, string][] {
  const box = wikitext.match(/\{\{\s*Infobox[\s\S]*?\n\}\}/i)?.[0] ?? "";
  return [...box.matchAll(/^\|\s*([^=|\n]+?)\s*=\s*(.*)$/gm)].map((m) => [m[1].toLowerCase(), m[2]]);
}

/** Тома и главы из инфобокса серии; форма — по слову «manga»/«novel», иначе null (решает первоисточник). */
export function parseAdaptation(wikitext: string): { form: AdaptForm | null; vols: number[]; chs: number[] } | null {
  const text = fields(wikitext).filter(([k, v]) => FIELD.test(k) && v.trim()).map(([k, v]) => `${k}: ${v}`).join(" ; ")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/<[^>]+>/g, " ");
  if (!text) return null;
  const nums = (re: RegExp) => [...text.matchAll(re)].flatMap((m) => {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return b >= a && b - a < 60 ? Array.from({ length: Math.floor(b - a) + 1 }, (_, i) => a + i) : [a];
  });
  const vols = nums(/\bvol(?:ume)?s?\.?\s*(\d+)(?:\s*[-–~]\s*(\d+))?/gi);
  const chs = nums(/\bch(?:apter)?s?\.?\s*(\d+)(?:\s*[-–~]\s*(\d+))?/gi);
  if (!vols.length && !chs.length) return null;
  return { form: /manga/i.test(text) ? "manga" : /novel/i.test(text) ? "novel" : null, vols, chs };
}

/** Диапазон сезона по сериям: тома, если они есть у большинства серий с данными, иначе главы. */
export function seasonRange(eps: ReturnType<typeof parseAdaptation>[], fallback: AdaptForm): Omit<AdaptRange, "source"> | null {
  const got = eps.filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (!got.length) return null;
  const withVol = got.filter((e) => e.vols.length);
  const unit: AdaptUnit = withVol.length * 2 >= got.length ? "vol" : "ch";
  const all = got.flatMap((e) => (unit === "vol" ? e.vols : e.chs));
  if (!all.length) return null;
  const form = got.find((e) => e.form)?.form ?? fallback;
  return { form, unit, from: Math.min(...all), to: Math.max(...all) };
}

/** Форма книги по первоисточнику аниме (AniList source). */
export const sourceForm = (source: string | null): AdaptForm => (source === "MANGA" || source === "WEB_MANGA" ? "manga" : "novel");

/** Подпись: «ранобэ, тома 1–4», «манга, гл. 1–38». */
export function adaptLabel(r: Pick<AdaptRange, "form" | "unit" | "from" | "to">): string {
  const what = r.form === "novel" ? "ранобэ" : "манга";
  const span = r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`;
  return `${what}, ${r.unit === "vol" ? (r.from === r.to ? "том" : "тома") : "гл."} ${span}`;
}

/** С чего читать после досмотренных сезонов: следующий том или глава после самого дальнего (null — не известно). */
export function continueAfter(watched: Pick<AdaptRange, "form" | "unit" | "to">[], form: AdaptForm): { unit: AdaptUnit; from: number } | null {
  const mine = watched.filter((r) => r.form === form);
  if (!mine.length) return null;
  const unit: AdaptUnit = mine.some((r) => r.unit === "vol") ? "vol" : "ch";
  return { unit, from: Math.floor(Math.max(...mine.filter((r) => r.unit === unit).map((r) => r.to))) + 1 };
}
