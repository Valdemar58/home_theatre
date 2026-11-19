import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { FA2_SETTINGS, layoutWeight } from "./graph-layout";

// Раскладки карты персонажей: «Граф» (ForceAtlas2, группы держатся вместе) и «Круги» (окружение выбранного персонажа).
// Обе — в долях 0..1 одного квадрата: переход между режимами — переезд узлов, без перерисовки.

export type Pos = { x: number; y: number };
type N = { id: number; groups: { id: number }[] };
type E = { a: number; b: number; kind: string; endedEp: number | null };

/** Тип отношения → группа цвета и близости */
export const REL_TONE: Record<string, "accent" | "positive" | "info" | "special" | "negative" | "neutral"> = {
  "служит": "accent", "наставник": "accent", "семья": "positive", "союзник": "positive",
  "друг": "info", "любовь": "special", "враг": "negative", "соперник": "negative", "другое": "neutral",
};
const CLOSE = new Set(["семья", "любовь", "друг", "наставник", "служит"]);
const HOSTILE = new Set(["враг", "соперник"]);

const fit = (pos: Map<number, Pos>, pad = 0.08) => {
  const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.max(x1 - x0, y1 - y0) || 1;
  const out = new Map<number, Pos>();
  for (const [id, p] of pos) out.set(id, { x: pad + ((p.x - x0) / s) * (1 - 2 * pad) + ((1 - 2 * pad) * (1 - (x1 - x0) / s)) / 2, y: pad + ((p.y - y0) / s) * (1 - 2 * pad) + ((1 - 2 * pad) * (1 - (y1 - y0) / s)) / 2 });
  return out;
};

/** «Граф»: силовая раскладка; члены одной группы тянутся друг к другу, связи между группами — слабее. */
export function graphLayout(nodes: N[], edges: E[]): Map<number, Pos> {
  const g = new Graph({ type: "undirected" });
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, nodes.length);
    g.addNode(String(n.id), { x: Math.cos(a), y: Math.sin(a) });
  });
  const group = new Map(nodes.map((n) => [n.id, n.groups[0]?.id ?? null]));
  const add = (a: number, b: number, w: number) => {
    const [s, t] = [String(a), String(b)];
    if (a === b || !g.hasNode(s) || !g.hasNode(t)) return;
    if (g.hasEdge(s, t)) g.updateEdgeAttribute(s, t, "weight", (x: number) => x + w);
    else g.addEdge(s, t, { weight: w });
  };
  for (const e of edges) add(e.a, e.b, layoutWeight(e.endedEp ? 0.5 : 1, group.get(e.a) !== null && group.get(e.a) === group.get(e.b)));
  // Невидимые пружины внутри группы — острова групп, как на общей карте
  const members = new Map<number, number[]>();
  for (const n of nodes) for (const gr of n.groups) members.set(gr.id, [...(members.get(gr.id) ?? []), n.id]);
  for (const ids of members.values()) for (let i = 1; i < ids.length; i++) add(ids[0], ids[i], 2);
  forceAtlas2.assign(g, { iterations: 400, settings: FA2_SETTINGS({ ...forceAtlas2.inferSettings(g), gravity: 2, scalingRatio: 6, edgeWeightInfluence: 1 }) });
  const pos = new Map<number, Pos>();
  g.forEachNode((k, a) => pos.set(Number(k), { x: a.x as number, y: a.y as number }));
  return fit(pos);
}

export type Ring = 0 | 1 | 2 | 3 | null;

/**
 * «Круги» вокруг focus: в центре он, дальше ближний круг (семья, друзья, наставник, служат), свои и союзники
 * (и близкие близких), знакомые и враги. Кто не связан с ним в два шага — не показывается (ring null).
 */
export function ringLayout(focus: number, nodes: N[], edges: E[]): Map<number, Pos & { ring: Ring }> {
  const live = edges.filter((e) => !e.endedEp);
  const near = (id: number) => live.filter((e) => e.a === id || e.b === id).map((e) => ({ other: e.a === id ? e.b : e.a, kind: e.kind }));
  const ring = new Map<number, Ring>([[focus, 0]]);
  const direct = near(focus);
  for (const d of direct) if (CLOSE.has(d.kind)) ring.set(d.other, 1);
  for (const d of direct) if (!ring.has(d.other) && !HOSTILE.has(d.kind)) ring.set(d.other, 2);
  for (const d of direct) if (!ring.has(d.other)) ring.set(d.other, 3);
  for (const d of direct.filter((x) => CLOSE.has(x.kind))) for (const s of near(d.other)) if (!ring.has(s.other)) ring.set(s.other, HOSTILE.has(s.kind) ? 3 : 2);
  for (const d of direct) for (const s of near(d.other)) if (!ring.has(s.other)) ring.set(s.other, 3);
  const R = [0, 0.17, 0.3, 0.43];
  const out = new Map<number, Pos & { ring: Ring }>();
  const group = new Map(nodes.map((n) => [n.id, n.groups[0]?.id ?? 0]));
  for (const r of [0, 1, 2, 3] as const) {
    // По группам подряд — свои рядом на кольце
    const ids = nodes.map((n) => n.id).filter((id) => ring.get(id) === r).sort((a, b) => group.get(a)! - group.get(b)! || a - b);
    ids.forEach((id, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, ids.length) + (r % 2 ? Math.PI / Math.max(2, ids.length) : 0);
      out.set(id, { x: 0.5 + R[r] * Math.cos(a), y: 0.5 + R[r] * Math.sin(a), ring: r });
    });
  }
  // Не связанные — за краем, невидимые: при переходе в «Граф» выедут оттуда
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, { x: 0.5, y: 1.15, ring: null });
  return out;
}
