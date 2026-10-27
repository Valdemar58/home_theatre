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
const FILLER = new Set(["kingdom", "of", "the", "nation", "warrior", "great", "country", "empire", "republic", "dynasty", "land", "lands", "holy", "beast", "sorcerous", "sorceous", "village", "city", "town"]);
const core = (s: string) => normText(s).split(" ").filter((w) => w.length >= 3 && !FILLER.has(w));

/**
 * Подпись для места по английскому названию: все значимые слова названия есть в подписи (или наоборот).
 * «Dwargon» → «Warrior Nation Dwargon», «Jura Forest» → «Great Jura Forest». Несколько подходящих — самая короткая.
 */
export function matchLabel(name: string, labels: MapLabel[]): MapLabel | null {
  const words = core(name);
  if (!words.length) return null;
  const hits = labels.filter((l) => {
    const lw = core(l.text);
    return lw.length > 0 && (words.every((w) => lw.includes(w)) || lw.every((w) => words.includes(w)));
  });
  return hits.sort((a, b) => a.text.length - b.text.length)[0] ?? null;
}

/** Точка места без подписи — рядом с родителем, по кругу (у каждого своё место: по номеру среди детей родителя). */
export function insidePoint(parent: { x: number; y: number }, index: number, radius = 0.035): { x: number; y: number } {
  const angle = index * 2.399963; // золотой угол: соседи не налезают друг на друга
  const r = radius * (0.6 + 0.4 * ((index % 3) / 2));
  return { x: Math.min(0.98, Math.max(0.02, parent.x + Math.cos(angle) * r)), y: Math.min(0.98, Math.max(0.02, parent.y + Math.sin(angle) * r)) };
}

/** Радиус открытого тумана вокруг места — по виду: страна и лес открывают больше, здание — пятачок. */
export const FOG_RADIUS: Record<string, number> = {
  "мир": 0.5, "континент": 0.3, "страна": 0.12, "область": 0.1, "лес": 0.11, "горы": 0.08, "водоём": 0.06,
  "город": 0.05, "деревня": 0.045, "пещера": 0.04, "здание": 0.03, "другое": 0.04,
};
