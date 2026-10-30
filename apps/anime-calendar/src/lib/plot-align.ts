// Сопоставление серий аниме и глав книги по сюжету (TASKS 5.11): похожесть пересказов (эмбеддинги) → выравнивание
// по порядку. Глава достаётся одной серии или пропускается (не экранизирована); серии идут по порядку, номер серии
// у глав не убывает; серия без глав (аниме-оригинал) — со штрафом. Чистые функции — для тестов.

export type Alignment = {
  /** Для каждой серии — индексы глав [первая, последняя] или null (глав не нашлось) */
  episodes: ([number, number] | null)[];
  /** Средняя похожесть глав серии на её пересказ (уверенность), по сериям */
  score: (number | null)[];
};

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** Похожесть глав на серии: sim[глава][серия] (векторы уже нормированы). */
export const simMatrix = (chapters: number[][], episodes: number[][]) => chapters.map((c) => episodes.map((e) => dot(c, e)));

/**
 * Выравнивание: глава j — серии i или пропуск (0). Выгода — насколько серия выделяется среди всех серий для этой
 * главы (z по строке) минус порог: глава вне сезона похожа на все серии одинаково (те же герои) — её пропускаем.
 * Номер серии у глав не убывает; перескок через серию (серия без глав) — штраф skipEp.
 */
export function alignPlot(sim: number[][], opts: { skipEp?: number; threshold?: number } = {}): Alignment {
  const m = sim.length;
  const n = m ? sim[0].length : 0;
  if (!m || !n) return { episodes: Array.from({ length: n }, () => null), score: Array.from({ length: n }, () => null) };
  const thr = opts.threshold ?? 1;
  const skipEp = opts.skipEp ?? 0.5;
  const z = sim.map((row) => {
    const mean = row.reduce((s, x) => s + x, 0) / row.length;
    const sd = Math.sqrt(row.reduce((s, x) => s + (x - mean) ** 2, 0) / row.length);
    return row.map((x) => (sd > 1e-6 ? (x - mean) / sd : 0) - thr);
  });
  // f[i+1] — лучший счёт, если последняя назначенная глава — серии i (f[0] — ещё ни одной)
  const NEG = -Infinity;
  let f = Array.from({ length: n + 1 }, (_, k) => (k === 0 ? 0 : NEG));
  const back: Int32Array[] = []; // откуда пришли: -1 — глава пропущена, иначе прежнее состояние
  for (let j = 0; j < m; j++) {
    const g = f.slice();
    const from = new Int32Array(n + 1).fill(-1);
    for (let s = 1; s <= n; s++) {
      const gain = z[j][s - 1];
      // в ту же серию, в следующую, или через пропущенные серии (штраф за каждую)
      for (let p = s; p >= Math.max(0, s - 3); p--) {
        if (f[p] === NEG) continue;
        const pen = p === 0 ? (s - 1) * skipEp * 0.25 : Math.max(0, s - p - 1) * skipEp;
        const v = f[p] + gain - pen;
        if (v > g[s]) { g[s] = v; from[s] = p; }
      }
    }
    back.push(from);
    f = g;
  }
  // Конец — в лучшем состоянии; хвост серий без глав не штрафуем (окно глав могло кончиться раньше)
  let s = 0;
  for (let k = 1; k <= n; k++) if (f[k] > f[s]) s = k;
  const assign = new Int32Array(m).fill(-1);
  for (let j = m - 1; j >= 0; j--) {
    const p = back[j][s];
    if (p === -1) continue;
    assign[j] = s - 1;
    s = p;
  }
  // Пустая серия после серии с несколькими главами (а дальше снова есть главы) — делим главы предыдущей там, где
  // граница лучше по смыслу (петли сюжета: пересказ длинной серии похож и на следующую)
  for (let i = 1; i < n - 1; i++) {
    if (assign.includes(i) || !assign.some((e) => e > i)) continue;
    const prev = [...assign.keys()].filter((j) => assign[j] === i - 1);
    if (prev.length < 2) continue;
    let best = -Infinity, cut = -1;
    for (let k = 1; k < prev.length; k++) {
      const v = prev.slice(0, k).reduce((t, j) => t + z[j][i - 1], 0) + prev.slice(k).reduce((t, j) => t + z[j][i], 0);
      if (v > best) { best = v; cut = k; }
    }
    if (cut > 0 && prev.slice(cut).reduce((t, j) => t + z[j][i], 0) > 0) for (const j of prev.slice(cut)) assign[j] = i;
  }
  const episodes: ([number, number] | null)[] = Array.from({ length: n }, () => null);
  const sums = new Array<number>(n).fill(0), counts = new Array<number>(n).fill(0);
  assign.forEach((e, j) => {
    if (e < 0) return;
    const r = episodes[e];
    episodes[e] = r ? [r[0], j] : [j, j];
    sums[e] += sim[j][e];
    counts[e]++;
  });
  return { episodes, score: counts.map((c, i) => (c ? Math.round((sums[i] / c) * 1000) / 1000 : null)) };
}

/** Окно глав исчерпано: последняя серия с главами ещё не последняя, а главы кончились у края окна — нужно больше глав. */
export function needsMore(a: Alignment, chapters: number): boolean {
  const lastEp = a.episodes.findLastIndex((r) => r !== null);
  if (lastEp < 0) return chapters > 0;
  const lastCh = a.episodes[lastEp]![1];
  return lastEp < a.episodes.length - 1 && lastCh >= chapters - Math.max(2, Math.ceil(chapters * 0.1));
}
