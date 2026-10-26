import "server-only";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { FA2_SETTINGS, layoutWeight } from "@/lib/graph-layout";
import { gql } from "../anilist";
import { cached } from "../cache";
import { db } from "../db";
import { chatJSON, llmAvailable } from "../llm";
import { cosine } from "./math";
import { loadTaste } from "./engine";
import { ensureProfileData, getProfiles, type Profile } from "./profile";

// Граф аниме как в Obsidian: мои тайтлы, рекомендации и соседи; кластеры по содержанию.

export type GraphNode = {
  id: number;
  label: string;
  x: number;
  y: number;
  size: number;
  cluster: number;
  kind: "mine" | "rec" | "other";
  status: string | null;
  myScore: number;
  score: number | null;
  cover: string | null;
  genres: string[];
};
export type GraphEdge = { source: number; target: number; kind: "relation" | "community" | "similar"; weight: number };
export type GraphCluster = { id: number; name: string; color: string; size: number; top: string[] };
export type GraphResponse = { nodes: GraphNode[]; edges: GraphEdge[]; clusters: GraphCluster[] };

// Палитра кластеров (хорошо различимые на тёмном фоне)
const COLORS = ["#818cf8", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#f87171", "#a78bfa", "#2dd4bf", "#fb923c", "#a3e635", "#e879f9", "#38bdf8"];
const MAX_NODES = 650;
const BFS_NODES = 450;

const titleOf = (p: Profile) => p.data.titleRu ?? p.data.title;

/** Теги о сюжете и сеттинге (без «Cast-*»: состав героев есть почти у всех и кластер не описывает). */
export function countTags(members: Profile[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of members) {
    for (const t of m.data.tags) {
      if (t.rank >= 60 && /^(Theme|Setting)/.test(t.category)) out.set(t.name, (out.get(t.name) ?? 0) + 1);
    }
  }
  return out;
}

const POPULAR_QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) { id }
  }
}`;

/** 300 самых популярных аниме AniList (кэш на неделю). */
function popularIds(): Promise<number[]> {
  return cached("graph-popular:v1", 7 * 86400, async () => {
    const out: number[] = [];
    for (let page = 1; page <= 6; page++) {
      const data = await gql<{ Page: { media: { id: number }[] } }>(POPULAR_QUERY, { page });
      out.push(...data.Page.media.map((m) => m.id));
    }
    return out;
  }).catch(() => []);
}

/** Название кластера: LLM по самым заметным тайтлам и тегам, иначе — по общим тегам. */
async function clusterName(members: Profile[], globalFreq: Map<string, number>, used: string[]): Promise<string> {
  const top = [...members].sort((a, b) => b.data.popularity - a.data.popularity).slice(0, 8);
  const tagCount = countTags(members);
  // Характерные теги: частые в кластере и редкие во всём графе (иначе везде «Male Protagonist»)
  const tags = [...tagCount]
    .filter(([, n]) => n >= Math.max(2, members.length * 0.15))
    .map(([t, n]) => [t, (n / members.length) / (globalFreq.get(t) ?? 1)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t]) => t);
  const fallback = tags.slice(0, 2).join(" · ") || top[0]?.data.genres.slice(0, 2).join(" · ") || "Разное";
  if (!(await llmAvailable())) return fallback;
  // Занятые названия входят в ключ: они сами закэшированы, так что ключ стабилен между пересчётами
  const key = `graph-cluster:v3:${top.map((m) => m.data.id).sort().join(",")}|${used.join("|")}`;
  return cached(key, 30 * 86400, async () => {
    const res = await chatJSON<{ name: string }>(
      { type: "object", properties: { name: { type: "string", description: "2–4 слова по-русски" } }, required: ["name"] },
      "Ты называешь подборки похожих аниме — как разделы каталога на стриминговом сервисе: понятно с первого взгляда, " +
        "по сути и настроению, без вычурных метафор и игры слов. Примеры хороших названий: «Попаданцы в фэнтези-мир», " +
        "«Спортивные команды», «Мрачные психологические триллеры», «Повседневность и уют», «Меха и космос».",
      `Тайтлы: ${top.map(titleOf).join("; ")}\nЧастые теги: ${tags.join(", ")}` +
        (used.length ? `\nУже заняты другими группами (не повторяй): ${used.join("; ")}` : "") +
        "\nНазвание группы:",
    ).catch(() => ({ name: fallback }));
    return res.name.trim() || fallback;
  });
}

/** Название, не совпадающее с уже выданными: при повторе добавляем самый известный тайтл кластера. */
export async function uniqueName(members: Profile[], globalFreq: Map<string, number>, used: string[]): Promise<string> {
  const name = await clusterName(members, globalFreq, used);
  if (!used.some((u) => u.toLowerCase() === name.toLowerCase())) return name;
  const star = [...members].sort((a, b) => b.data.popularity - a.data.popularity)[0];
  return star ? `${name} · ${titleOf(star)}` : `${name} ${used.length + 1}`;
}

export async function buildGraph(userId: number): Promise<GraphResponse> {
  const taste = await loadTaste(userId);
  const status = new Map(taste.rows.map((r) => [r.anilist_id, r]));
  const recRow = db.prepare<[number], { recs: string | null }>("SELECT recs FROM user_taste WHERE user_id = ?").get(userId);
  const recIds: number[] = recRow?.recs ? (JSON.parse(recRow.recs) as { items: { id: number }[] }).items.map((i) => i.id) : [];

  // Узлы: мои тайтлы → рекомендации → соседи понравившегося по рекомендациям сообщества
  const ids = new Set<number>(taste.rows.map((r) => r.anilist_id));
  for (const id of recIds.slice(0, 40)) ids.add(id);
  // Соседи всего моего (у понравившегося — больше)
  for (const [id, w] of [...taste.weights].sort((a, b) => b[1] - a[1])) {
    for (const r of taste.profiles.get(id)?.data.recs.slice(0, w > 0.15 ? 12 : 5) ?? []) ids.add(r.id);
  }
  // Обход в ширину по рекомендациям сообщества: соседи соседей, пока граф не наберёт размер.
  // У похожих тайтлов списки рекомендаций сильно пересекаются, поэтому идём волнами
  let frontier = [...ids];
  for (let hop = 0; hop < 3 && frontier.length && ids.size < BFS_NODES; hop++) {
    await ensureProfileData(frontier);
    const next: number[] = [];
    for (const [, p] of getProfiles(frontier)) {
      for (const r of p.data.recs.slice(0, 6)) {
        if (ids.size >= BFS_NODES) break;
        if (!ids.has(r.id)) { ids.add(r.id); next.push(r.id); }
      }
    }
    frontier = next;
  }
  // Фон — самые популярные тайтлы: карта остаётся полной даже при коротком списке
  for (const id of await popularIds()) {
    if (ids.size >= MAX_NODES) break;
    ids.add(id);
  }
  const nodeIds = [...ids].slice(0, MAX_NODES);
  await ensureProfileData(nodeIds);
  const profiles = getProfiles(nodeIds);

  const g = new Graph({ type: "undirected", multi: false });
  for (const [id, p] of profiles) {
    g.addNode(String(id), { x: Math.cos(id) * 100, y: Math.sin(id * 1.7) * 100, profile: p });
  }
  const addEdge = (a: number, b: number, kind: GraphEdge["kind"], weight: number) => {
    const A = String(a);
    const B = String(b);
    if (a === b || !g.hasNode(A) || !g.hasNode(B)) return;
    if (g.hasEdge(A, B)) {
      g.updateEdgeAttribute(A, B, "weight", (w: number) => w + weight);
      return;
    }
    g.addEdge(A, B, { kind, weight });
  };
  for (const [id, p] of profiles) {
    for (const r of p.data.relations) addEdge(id, r.id, "relation", 3);
    // Только сильнейшие рекомендации: иначе популярные тайтлы связывают всё со всем и граф превращается в клубок
    for (const r of p.data.recs.slice(0, 6)) addEdge(id, r.id, "community", Math.min(2, Math.log1p(r.rating) / 2));
  }
  // Похожесть по содержанию: 4 ближайших соседа с достаточным сходством
  const embedded = [...profiles].filter(([, p]) => p.embedding);
  for (const [id, p] of embedded) {
    const near = embedded
      .filter(([other]) => other !== id)
      .map(([other, q]) => ({ other, sim: cosine(p.embedding!, q.embedding!) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 4)
      .filter((n) => n.sim > 0.55);
    for (const n of near) addEdge(id, n.other, "similar", (n.sim - 0.5) * 4);
  }

  // Кластеры и раскладка
  const communities = louvain(g, { getEdgeWeight: "weight", resolution: 1.1 });
  g.forEachEdge((e, attrs, s, t) => g.setEdgeAttribute(e, "layoutWeight", layoutWeight(attrs.weight, communities[s] === communities[t])));
  forceAtlas2.assign(g, { iterations: 600, getEdgeWeight: "layoutWeight", settings: FA2_SETTINGS(forceAtlas2.inferSettings(g)) });

  const byCluster = new Map<number, Profile[]>();
  g.forEachNode((key) => {
    const c = communities[key];
    const p = g.getNodeAttribute(key, "profile") as Profile;
    byCluster.set(c, [...(byCluster.get(c) ?? []), p]);
  });
  // Крупные кластеры получают названия и цвета; мелкие объединяем в «Разное»
  const ordered = [...byCluster].sort((a, b) => b[1].length - a[1].length);
  const big = ordered.filter(([, m]) => m.length >= 4).slice(0, COLORS.length);
  const remap = new Map<number, number>(big.map(([c], i) => [c, i]));
  const clusters: GraphCluster[] = [];
  const all = [...profiles.values()];
  const globalFreq = new Map([...countTags(all)].map(([t, n]) => [t, n / all.length]));
  for (const [c, members] of big) {
    clusters.push({
      id: remap.get(c)!,
      name: await uniqueName(members, globalFreq, clusters.map((x) => x.name)),
      color: COLORS[remap.get(c)! % COLORS.length],
      size: members.length,
      top: [...members].sort((a, b) => b.data.popularity - a.data.popularity).slice(0, 5).map(titleOf),
    });
  }
  const OTHER = clusters.length;
  if (ordered.length > big.length) clusters.push({ id: OTHER, name: "Разное", color: "#6b7280", size: 0, top: [] });

  const recSet = new Set(recIds);
  const nodes: GraphNode[] = [];
  g.forEachNode((key, attrs) => {
    const p = attrs.profile as Profile;
    const id = Number(key);
    const entry = status.get(id);
    const cluster = remap.get(communities[key]) ?? OTHER;
    if (cluster === OTHER) clusters[OTHER].size++;
    const mine = Boolean(entry && entry.status !== "planned");
    nodes.push({
      id,
      label: titleOf(p),
      x: attrs.x as number,
      y: attrs.y as number,
      size: mine ? 6 + (entry!.score || 5) * 0.8 : recSet.has(id) ? 7 : 3 + Math.min(4, Math.log10(1 + p.data.popularity)),
      cluster,
      kind: mine ? "mine" : recSet.has(id) ? "rec" : "other",
      status: entry?.status ?? null,
      myScore: entry?.score ?? 0,
      score: p.data.score,
      cover: p.data.cover,
      genres: p.data.genres.slice(0, 3),
    });
  });
  const edges: GraphEdge[] = [];
  g.forEachEdge((_e, attrs, s, t) => edges.push({ source: Number(s), target: Number(t), kind: attrs.kind, weight: attrs.weight }));
  return { nodes, edges, clusters };
}
