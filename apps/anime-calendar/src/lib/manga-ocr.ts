// Автоперевод манги (TASKS 5.8): строки текста страницы (dots.mocr в mapvec, рамки в пикселях) → пузыри.
// Строки одного пузыря стоят вплотную: рамки, расширенные на долю размера знака, пересекаются. Японские
// вертикальные колонки читаются справа налево, горизонтальные строки — сверху вниз.

/** Перевод страницы для ридера: размер страницы в пикселях, рамки пузырей — в долях 0–1000. */
export type MangaAiPage = { w: number; h: number; bubbles: { x0: number; y0: number; x1: number; y1: number; text: string; ru: string; vertical: boolean }[] };

export type OcrLine = { text: string; x0: number; y0: number; x1: number; y1: number };
export type Bubble = { text: string; x0: number; y0: number; x1: number; y1: number; vertical: boolean };

const CJK = /[぀-ヿ一-鿿]/;
/** Колонка японского текста: заметно выше, чем шире, и с японскими знаками. */
const isVertical = (l: OcrLine) => CJK.test(l.text) && l.y1 - l.y0 > (l.x1 - l.x0) * 1.3;
/** Размер знака: ширина колонки или высота строки. */
const glyph = (l: OcrLine) => (isVertical(l) ? l.x1 - l.x0 : l.y1 - l.y0);

export function bubbles(lines: OcrLine[], gap = 0.6): Bubble[] {
  const ls = lines.filter((l) => l.text.replace(/[\s\p{P}]/gu, "").length > 0 && l.x1 > l.x0 && l.y1 > l.y0);
  const parent = ls.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ls.length; i++) {
    for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i], b = ls[j];
      // Разное направление — разные пузыри (подпись рядом с репликой)
      if (isVertical(a) !== isVertical(b)) continue;
      const g = Math.min(glyph(a), glyph(b)) * gap;
      // Знаки сильно разного размера — звукоподражание рядом с репликой
      if (Math.max(glyph(a), glyph(b)) > Math.min(glyph(a), glyph(b)) * 1.8) continue;
      const near = a.x0 - g < b.x1 && b.x0 - g < a.x1 && a.y0 - g < b.y1 && b.y0 - g < a.y1;
      if (near) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, OcrLine[]>();
  ls.forEach((l, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), l]);
  });
  return [...groups.values()].map((g) => {
    const vertical = g.filter(isVertical).length * 2 > g.length;
    const order = [...g].sort(vertical ? (a, b) => b.x1 - a.x1 || a.y0 - b.y0 : (a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return {
      text: order.map((l) => l.text.trim()).join(vertical ? "" : " "),
      x0: Math.min(...g.map((l) => l.x0)), y0: Math.min(...g.map((l) => l.y0)),
      x1: Math.max(...g.map((l) => l.x1)), y1: Math.max(...g.map((l) => l.y1)), vertical,
    };
  })
    // Номера страниц и одиночные знаки — не реплики
    .filter((b) => (b.text.match(/\p{L}/gu) ?? []).length >= (CJK.test(b.text) ? 1 : 2))
    .sort((a, b) => a.y0 - b.y0 || b.x1 - a.x1);
}

/** Размер шрифта перевода в пикселях страницы: текст должен влезть в рамку пузыря (с запасом на перенос). */
export function fitFont(text: string, w: number, h: number): number {
  const len = Math.max(1, text.length);
  // Площадь знака ≈ 0,55 × высота², строки с интервалом 1,1; запас на перенос по словам — 1,7
  const size = Math.sqrt((w * h) / (len * 0.55 * 1.1 * 1.7));
  return Math.max(8, Math.min(size, h * 0.9, w * 0.45, 40));
}
