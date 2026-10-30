import { chapterName, type Edition, type EditionSummary } from "./books";

// Уведомления о новых главах (TASKS 5.5): снимок — сколько глав на русском, английском и в оригинале у каждого
// издания. Выросло на русском — «вышла глава N на русском»; на английском или в оригинале — только если на русском
// этой главы нет («на русском пока нет»). Первый снимок книги только запоминается.

const LANGS = ["ru", "en", "orig"] as const;
export type ChapterSnap = Record<string, Partial<Record<(typeof LANGS)[number], number>>>;

export function chapterSnap(editions: EditionSummary[]): ChapterSnap {
  const out: ChapterSnap = {};
  for (const e of editions) {
    out[e.edition] = {};
    for (const l of LANGS) out[e.edition][l] = e.langs.find((s) => s.lang === l)?.count ?? 0;
  }
  return out;
}

/** Снимок для записи: по каждому языку — больший из двух (провайдер удалил главу и вернул — не сообщать снова). */
export function mergeSnap(prev: ChapterSnap | null, cur: ChapterSnap): ChapterSnap {
  const out: ChapterSnap = { ...prev };
  for (const [ed, langs] of Object.entries(cur)) {
    out[ed] = { ...out[ed] };
    for (const l of LANGS) out[ed][l] = Math.max(out[ed][l] ?? 0, langs[l] ?? 0);
  }
  return out;
}

const LANG_RU: Record<string, string> = { en: "на английском", orig: "в оригинале" };
const ED: Record<Edition, string> = { main: "", web: " (веб-версия)", book: " (книжная версия)" };

function chapters(n: number): string {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "глава" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "главы" : "глав";
}

/** Что сообщить по книге: сравнение прошлого снимка с текущими главами (null — нечего). */
export function chapterNotice(prev: ChapterSnap, editions: EditionSummary[]): { title: string } | null {
  const many = editions.length > 1;
  for (const e of editions) {
    const was = prev[e.edition];
    if (!was) continue;
    const ed = many ? ED[e.edition] : "";
    const count = (l: string) => e.langs.find((s) => s.lang === l)?.count ?? 0;
    const grewRu = count("ru") - (was.ru ?? 0);
    if (grewRu > 0) {
      const last = [...e.chapters].reverse().find((c) => c.langs.ru);
      if (!last) continue;
      const name = chapterName(last, e.edition);
      return { title: grewRu === 1 ? `${name} вышла на русском${ed}` : `${grewRu} ${chapters(grewRu)} на русском${ed}, последняя — ${name.toLowerCase()}` };
    }
    for (const l of ["en", "orig"] as const) {
      if (count(l) - (was[l] ?? 0) <= 0) continue;
      const last = [...e.chapters].reverse().find((c) => c.langs[l]);
      if (!last || last.langs.ru) continue;
      return { title: `${chapterName(last, e.edition)} вышла ${LANG_RU[l]}${ed}, на русском пока нет` };
    }
  }
  return null;
}
