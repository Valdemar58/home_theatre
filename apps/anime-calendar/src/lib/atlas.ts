// Карта тайтлов: общие для сервера и браузера правила — цвета и размеры, острова, «живая» физика соседей.

/** Узел карты: тайтл с готовыми координатами (раскладка считается на сервере заранее). */
export type AtlasNode = {
  id: number;
  label: string;
  x: number;
  y: number;
  size: number;
  cluster: number;
  popularity: number;
  /** Оценка 0–10 (MAL через Shikimori, иначе AniList) */
  score: number | null;
  year: number | null;
  format: string | null;
  episodes: number | null;
  genres: string[];
  cover: string | null;
};

/** Остров: сообщество тайтлов (Louvain) с названием от LLM. */
export type AtlasCluster = { id: number; name: string; color: string; x: number; y: number; size: number; top: string[] };

/** Ребро: индексы узлов, вес, вид (0 — продолжение, 1 — «похожее» сообщества, 2 — сходство по содержанию). */
export type AtlasEdge = [number, number, number, 0 | 1 | 2];

export type Atlas = { builtAt: number; nodes: AtlasNode[]; edges: AtlasEdge[]; clusters: AtlasCluster[] };

export type AtlasStatus = {
  state: "idle" | "building" | "error";
  phase: string | null;
  done: number;
  total: number;
  builtAt: number | null;
  error: string | null;
};

/** Цвета островов: равномерный круг оттенков (шаг — золотой угол), одинаковые насыщенность и светлота. */
export function clusterColors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => hslHex((i * 137.508 + 210) % 360, 0.62, 0.64));
}

export function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Размер точки — по популярности: знаменитое крупнее и подписывается раньше при приближении. */
export const nodeSize = (popularity: number) => Math.round((1.6 + Math.pow(Math.max(popularity, 0) / 1000, 0.36)) * 10) / 10;

/**
 * Мелкие сообщества (меньше minSize) — к соседнему крупному, с которым больше всего связей:
 * так карта — острова, а не россыпь точек «Разное». Без связей с крупными — остаются как есть.
 */
export function mergeSmall(community: Map<number, number>, edges: [number, number, number][], minSize: number): Map<number, number> {
  const out = new Map(community);
  for (let pass = 0; pass < 3; pass++) {
    const sizes = new Map<number, number>();
    for (const c of out.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const pull = new Map<number, Map<number, number>>();
    for (const [a, b, w] of edges) {
      const ca = out.get(a);
      const cb = out.get(b);
      if (ca === undefined || cb === undefined || ca === cb) continue;
      for (const [node, own, other] of [[a, ca, cb], [b, cb, ca]] as const) {
        if ((sizes.get(own) ?? 0) >= minSize || (sizes.get(other) ?? 0) < minSize) continue;
        const m = pull.get(node) ?? new Map<number, number>();
        m.set(other, (m.get(other) ?? 0) + w);
        pull.set(node, m);
      }
    }
    if (!pull.size) break;
    for (const [node, m] of pull) out.set(node, [...m].sort((x, y) => y[1] - x[1])[0][0]);
  }
  return out;
}

/** Пятна островов: точки одного острова, собранные по клеткам сетки (центр, радиус, остров). */
export function islandBlobs(nodes: Pick<AtlasNode, "x" | "y" | "cluster">[], cell: number): [number, number, number, number][] {
  const cells = new Map<string, { x: number; y: number; n: number; c: number }>();
  for (const p of nodes) {
    const key = `${p.cluster}:${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    const v = cells.get(key) ?? { x: 0, y: 0, n: 0, c: p.cluster };
    v.x += p.x;
    v.y += p.y;
    v.n++;
    cells.set(key, v);
  }
  return [...cells.values()].map((v) => [v.x / v.n, v.y / v.n, cell * (0.75 + Math.min(1.1, Math.sqrt(v.n) * 0.28)), v.c]);
}

export type SimNode = { x: number; y: number; vx: number; vy: number; r: number; fixed: boolean };
/** Связь: индексы узлов, длина покоя (расстояние до начала перетаскивания), жёсткость по силе связи */
export type SimLink = { a: number; b: number; rest: number; k: number };

/**
 * Шаг физики как в Obsidian: связи — пружины (сильные тянут сильнее), точки не налезают друг на друга,
 * скорость гасится трением; alpha — «температура» (1 пока тянем, после отпускания остывает).
 * Неподвижные (fixed) узлы — опора: за них держатся связи, их не двигаем. Возвращает суммарную скорость.
 */
export function simStep(nodes: SimNode[], links: SimLink[], alpha: number, friction = 0.7): number {
  for (const l of links) {
    const a = nodes[l.a];
    const b = nodes[l.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = ((d - l.rest) / d) * l.k * alpha;
    const share = a.fixed || b.fixed ? 1 : 0.5;
    if (!a.fixed) { a.vx += dx * f * share; a.vy += dy * f * share; }
    if (!b.fixed) { b.vx -= dx * f * share; b.vy -= dy * f * share; }
  }
  // Столкновения: подвижный узел выталкивается из соседних точек
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.fixed) continue;
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const min = a.r + b.r + 2;
      if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
      const d = Math.hypot(dx, dy) || 0.01;
      if (d >= min) continue;
      const push = ((min - d) / d) * (b.fixed ? 0.5 : 0.25);
      a.vx += dx * push;
      a.vy += dy * push;
    }
  }
  let energy = 0;
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx *= friction;
    n.vy *= friction;
    n.x += n.vx;
    n.y += n.vy;
    energy += Math.abs(n.vx) + Math.abs(n.vy);
  }
  return energy;
}

type Pt = { x: number; y: number };

/** Радиус острова по числу тайтлов: площадь растёт пропорционально. */
export const islandRadius = (n: number, spacing = 17) => Math.max(30, spacing * Math.sqrt(n));

/**
 * Раскладка островов-кругов: связанные (links — «a:b» → вес 0–1) тянутся друг к другу,
 * но не ближе чем на gap («море» между островами). Крупные — в центре.
 */
export function packIslands(radii: number[], links: Map<string, number>, gap: number, iterations = 700): Pt[] {
  const pos = radii.map((_, i) => {
    const a = i * 2.39996;
    const r = Math.sqrt(i) * (radii[0] ?? 100) * 0.9;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const pairs = [...links].map(([k, w]) => [...k.split(":").map(Number), w] as [number, number, number]);
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (const [a, b, w] of pairs) {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = radii[a] + radii[b] + gap;
      if (d <= rest) continue;
      const f = ((d - rest) * 0.03 * w * cool) / d;
      pos[a].x += dx * f; pos[a].y += dy * f;
      pos[b].x -= dx * f; pos[b].y -= dy * f;
    }
    for (const p of pos) { p.x *= 1 - 0.004 * cool; p.y *= 1 - 0.004 * cool; }
    separate(pos, radii, gap);
  }
  for (let i = 0; i < 50; i++) separate(pos, radii, gap);
  return pos;
}

/** Растолкать пересекающиеся круги (каждый на половину перекрытия). */
function separate(pos: Pt[], radii: number[], gap: number) {
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      const dx = pos[j].x - pos[i].x;
      const dy = pos[j].y - pos[i].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const min = radii[i] + radii[j] + gap;
      if (d >= min) continue;
      const push = (min - d) / 2 / d;
      pos[i].x -= dx * push; pos[i].y -= dy * push;
      pos[j].x += dx * push; pos[j].y += dy * push;
    }
  }
}

/**
 * Местная раскладка острова → круг радиуса R вокруг (0, 0): форма сохраняется, но плотность
 * выравнивается (иначе ядро слипается, а края пустеют): радиус — наполовину по рангу.
 */
export function shapeIsland(pts: Pt[], R: number): Pt[] {
  if (pts.length === 1) return [{ x: 0, y: 0 }];
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const polar = pts.map((p, i) => ({ i, a: Math.atan2(p.y - cy, p.x - cx), r: Math.hypot(p.x - cx, p.y - cy) }));
  const max = Math.max(...polar.map((p) => p.r)) || 1;
  const out: Pt[] = new Array(pts.length);
  [...polar].sort((a, b) => a.r - b.r).forEach((p, rank) => {
    const r = R * (0.55 * Math.sqrt((rank + 0.5) / pts.length) + 0.45 * (p.r / max));
    out[p.i] = { x: Math.cos(p.a) * r, y: Math.sin(p.a) * r };
  });
  return out;
}

/** Убрать наложения точек (радиусы sizes + зазор) — несколько проходов по сетке. */
export function relaxOverlaps(pts: Pt[], sizes: number[], pad = 1.5, passes = 12): void {
  const cell = Math.max(...sizes) * 2 + pad * 2;
  for (let pass = 0; pass < passes; pass++) {
    const grid = new Map<string, number[]>();
    pts.forEach((p, i) => {
      const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    });
    let moved = false;
    pts.forEach((p, i) => {
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(`${gx + ox}:${gy + oy}`) ?? []) {
          if (j <= i) continue;
          const q = pts[j];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const min = sizes[i] + sizes[j] + pad;
          if (d >= min) continue;
          const push = (min - d) / 2 / d;
          p.x -= dx * push; p.y -= dy * push;
          q.x += dx * push; q.y += dy * push;
          moved = true;
        }
      }
    });
    if (!moved) break;
  }
}
