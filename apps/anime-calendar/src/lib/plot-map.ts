// Карта мест франшизы: подложка (официальная карта с вики), подписи на ней (модель со зрением читает их кусками)
// и точки мест графа. Чистые правила: нарезка на куски, склейка строк подписи, совпадение подписи с местом,
// точка места без подписи (внутри родителя). Координаты — доли от 0 до 1 внутри вырезанной карты (без легенды).

export type Box = { x: number; y: number; w: number; h: number };
export type MapLabel = Box & { text: string };

/** Куски карты: сетка с перекрытием (подпись на границе целиком попадёт хотя бы в один кусок). */
export function tiles(width: number, height: number, size = 700, overlap = 0.18): Box[] {
  const step = Math.round(size * (1 - overlap));
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; ; x += step) { xs.push(Math.min(x, Math.max(0, width - size))); if (x + size >= width) break; }
  for (let y = 0; ; y += step) { ys.push(Math.min(y, Math.max(0, height - size))); if (y + size >= height) break; }
  return [...new Set(ys)].flatMap((y) => [...new Set(xs)].map((x) => ({ x, y, w: Math.min(size, width), h: Math.min(size, height) })));
}

const normText = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Строки одной подписи («Kingdom of» над «Brumund») — одна подпись: следующая строка сразу под предыдущей
 * (зазор меньше высоты строки) и по горизонтали пересекается больше чем наполовину.
 */
export function mergeLines(lines: MapLabel[]): MapLabel[] {
  const rest = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: MapLabel[] = [];
  while (rest.length) {
    const cur = { ...rest.shift()! };
    for (;;) {
      const i = rest.findIndex((n) => {
        const gap = n.y - (cur.y + cur.h);
        const lineH = Math.min(cur.h, n.h);
        const over = Math.min(cur.x + cur.w, n.x + n.w) - Math.max(cur.x, n.x);
        return gap > -lineH * 0.5 && gap < lineH * 0.8 && over > Math.min(cur.w, n.w) * 0.5;
      });
      if (i < 0) break;
      const n = rest.splice(i, 1)[0];
      const x = Math.min(cur.x, n.x), y = Math.min(cur.y, n.y);
      Object.assign(cur, { text: `${cur.text} ${n.text}`, x, y, w: Math.max(cur.x + cur.w, n.x + n.w) - x, h: Math.max(cur.y + cur.h, n.y + n.h) - y });
    }
    out.push(cur);
  }
  return out;
}

/** Одна и та же подпись из соседних кусков (перекрытие) — одна: тот же текст и центры рядом. */
export function dedupeLabels(labels: MapLabel[], near = 0.03): MapLabel[] {
  const out: MapLabel[] = [];
  for (const l of [...labels].sort((a, b) => b.text.length - a.text.length)) {
    const c = { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const dup = out.find((o) => {
      const d = Math.hypot(o.x + o.w / 2 - c.x, o.y + o.h / 2 - c.y);
      const a = normText(o.text), b = normText(l.text);
      return d < near && (a === b || a.includes(b) || b.includes(a));
    });
    if (!dup) out.push(l);
  }
  return out;
}

// Служебные слова в подписях стран: «Kingdom of Brumund», «Warrior Nation Dwargon», «Great Jura Forest»
const FILLER = new Set(["kingdom", "of", "the", "nation", "warrior", "great", "country", "empire", "republic", "dynasty", "land", "lands", "holy", "beast", "sorcerous", "sorceous", "village", "city", "town", "capital", "royal"]);
const core = (s: string) => normText(s).split(" ").filter((w) => w.length >= 3 && !FILLER.has(w));

/** Расстояние правки (вставка, удаление, замена) — для разного написания одного названия. */
function edits(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

/** Одно слово по-разному: Farmus ≈ Farmas, Blumund ≈ Brumund, Ingrassia ≈ Ingrasia (длинные слова, до двух правок). */
const sameWord = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && edits(a, b) <= 2);

/**
 * Может ли подпись называть это место: хоть одно значимое слово начинается на ту же букву. Отсекает явные промахи
 * модели («Farmus» → «Kingdom of Siltrozzo»), не мешая переводу названия («Urgray» → «Ulgreisia»).
 */
export function plausibleLabel(name: string, label: string): boolean {
  const a = core(name), b = core(label);
  return a.some((w) => b.some((v) => v[0] === w[0]));
}

/**
 * Подпись для места по английскому названию: все значимые слова названия есть в подписи.
 * «Dwargon» → «Warrior Nation Dwargon», «Jura Forest» → «Great Jura Forest». Несколько подходящих — самая короткая.
 * Обратного нет: «Dwargon mine» не садится на подпись Дваргона (у шахты своей подписи нет).
 */
export function matchLabel(name: string, labels: MapLabel[]): MapLabel | null {
  const words = core(name);
  if (!words.length) return null;
  // Сначала точные слова, и только без них — с допуском: «Dwargon» ≈ «Dragon» (две правки), но есть «Warrior Nation Dwargon»
  for (const same of [(a: string, b: string) => a === b, sameWord]) {
    const hits = labels.filter((l) => { const lw = core(l.text); return lw.length > 0 && words.every((w) => lw.some((v) => same(w, v))); });
    if (hits.length) return hits.sort((a, b) => a.text.length - b.text.length)[0];
  }
  return null;
}

/** Текст легенды, а не подпись места: «cap: Rondo», «pop: 1,000,000», абзац описания страны. */
export const isLegendText = (t: string) => /\b(cap|pop)\s*:/i.test(t) || t.trim().split(/\s+/).length > 6;

/**
 * Легенда рядом с картой (столбик абзацев о странах справа) — граница карты по ней: доля ширины, где легенда
 * начинается, или null (легенды нет). Модель не всегда отрезает её сама, а подписи из легенды путают места.
 */
export function legendEdge(labels: MapLabel[]): number | null {
  const legend = labels.filter((l) => isLegendText(l.text) && l.x > 0.5);
  if (legend.length < 4) return null;
  return Math.max(0.5, Math.min(...legend.map((l) => l.x)) - 0.01);
}

/** Подписи без легенды, в долях новой (подрезанной справа по edge) карты. */
export function dropLegend(labels: MapLabel[], edge: number | null): MapLabel[] {
  const kept = labels.filter((l) => !isLegendText(l.text) && (edge === null || l.x + l.w / 2 < edge));
  return edge === null ? kept : kept.map((l) => ({ ...l, x: l.x / edge, w: l.w / edge }));
}

/** Точка места без подписи — рядом с родителем, по кругу (у каждого своё место: по номеру среди детей родителя). */
export function insidePoint(parent: { x: number; y: number }, index: number, radius = 0.035): { x: number; y: number } {
  const angle = index * 2.399963; // золотой угол: соседи не налезают друг на друга
  const r = radius * (0.6 + 0.4 * ((index % 3) / 2));
  return { x: Math.min(0.98, Math.max(0.02, parent.x + Math.cos(angle) * r)), y: Math.min(0.98, Math.max(0.02, parent.y + Math.sin(angle) * r)) };
}

/**
 * Какие подписи мест показать, чтобы они не наезжали: по убыванию важности, подпись, задевающая уже показанную,
 * скрывается (точка остаётся). Прямоугольники — в долях карты на текущем масштабе.
 */
export function placeLabels<T extends Box & { id: number; priority: number }>(items: T[]): Set<number> {
  const shown: T[] = [];
  for (const it of [...items].sort((a, b) => b.priority - a.priority)) {
    const hit = shown.some((s) => it.x < s.x + s.w && s.x < it.x + it.w && it.y < s.y + s.h && s.y < it.y + it.h);
    if (!hit) shown.push(it);
  }
  return new Set(shown.map((s) => s.id));
}

/** Радиус открытого тумана вокруг места — по виду: страна и лес открывают больше, здание — пятачок. */
export const FOG_RADIUS: Record<string, number> = {
  "мир": 0.5, "континент": 0.3, "страна": 0.12, "область": 0.1, "лес": 0.11, "горы": 0.08, "водоём": 0.06,
  "город": 0.05, "деревня": 0.045, "пещера": 0.04, "здание": 0.03, "другое": 0.04,
};
