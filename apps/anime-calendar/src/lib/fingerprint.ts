// Опенинги и эндинги по звуку (TASKS 9.3): отпечатки chromaprint (`fpcalc -raw`) начала и конца серий сравниваются
// попарно — общий отрезок, совпадающий в соседних сериях, и есть OP/ED. Разведка на «Слизи»: совпадение с главами BD
// до 1 с; серия со своими OP/ED честно не находит общего. Правила без сети и файлов — для сервера и тестов.

/** Секунд на одну точку отпечатка fpcalc (окно 4096 отсчётов с шагом 1/3 при 11025 Гц). */
export const FP_STEP = 0.1238;

/** Число единичных битов 32-битного слова. */
export function popcount(x: number): number {
  let v = x >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Общий отрезок двух отпечатков: секунды от начала каждого. */
export type Run = { a0: number; a1: number; b0: number; b1: number };

/**
 * Самый длинный общий отрезок при любом сдвиге: точки совпадают, если различаются не больше чем maxBits битами;
 * разрывы до gap точек (шум, другая реплика поверх музыки) отрезок не рвут. Короче minSec — нет совпадения.
 */
export function commonRun(a: number[], b: number[], opts: { maxBits?: number; gap?: number; minSec?: number } = {}): Run | null {
  const { maxBits = 10, gap = 6, minSec = 20 } = opts;
  const minLen = Math.round(minSec / FP_STEP);
  let best: { len: number; i: number; j: number } | null = null;
  for (let sh = -b.length + 1; sh < a.length; sh++) {
    const i0 = Math.max(0, sh);
    const j0 = Math.max(0, -sh);
    const n = Math.min(a.length - i0, b.length - j0);
    if (n < minLen) continue;
    let start = -1;
    let last = -1;
    for (let k = 0; k < n; k++) {
      if (popcount(a[i0 + k] ^ b[j0 + k]) > maxBits) continue;
      if (start < 0 || k - last > gap) start = k;
      last = k;
      const len = last - start;
      if (!best || len > best.len) best = { len, i: i0 + start, j: j0 + start };
    }
  }
  if (!best || best.len < minLen) return null;
  const s = (x: number) => Math.round(x * FP_STEP * 10) / 10;
  return { a0: s(best.i), a1: s(best.i + best.len), b0: s(best.j), b1: s(best.j + best.len) };
}

export type Segment = { kind: "op" | "ed"; start: number; end: number };

/**
 * Отрезок серии по совпадениям с соседями: самый длинный (опенинги и эндинги — 60–150 с; короче 25 с —
 * случайная общая музыка, длиннее 180 с — повтор сцены). offset — где в серии начинается отпечаток (у конца — длительность
 * серии минус длина отпечатка).
 */
export function pickSegment(kind: Segment["kind"], runs: { start: number; end: number }[], offset = 0): Segment | null {
  const ok = runs.filter((r) => r.end - r.start >= 25 && r.end - r.start <= 180).sort((x, y) => (y.end - y.start) - (x.end - x.start));
  const r = ok[0];
  return r ? { kind, start: Math.round((r.start + offset) * 10) / 10, end: Math.round((r.end + offset) * 10) / 10 } : null;
}

/** Отрезки из глав файла: «Опенинг»/«Эндинг» (после chapterLabel) до начала следующей главы. */
export function segmentsFromChapters(chapters: { name: string; start: number }[], duration: number): Segment[] {
  const out: Segment[] = [];
  chapters.forEach((c, i) => {
    const kind = c.name === "Опенинг" ? "op" : c.name === "Эндинг" ? "ed" : null;
    if (!kind) return;
    const end = chapters[i + 1]?.start ?? duration;
    if (end - c.start >= 20 && end - c.start <= 200) out.push({ kind, start: c.start, end });
  });
  return out;
}
