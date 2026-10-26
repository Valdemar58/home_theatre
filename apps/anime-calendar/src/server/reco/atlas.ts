import "server-only";
import fs from "node:fs";
import path from "node:path";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { clusterColors, islandRadius, mergeSmall, nodeSize, packIslands, relaxOverlaps, shapeIsland, type Atlas, type AtlasCluster, type AtlasEdge, type AtlasNode, type AtlasStatus } from "@/lib/atlas";
import { gql } from "../anilist";
import { cached } from "../cache";
import { db, now } from "../db";
import { env } from "../env";
import { countTags, uniqueName } from "./graph";
import { ensureProfileData, getProfiles, quickEmbed, type Profile } from "./profile";

// Карта тайтлов (как MAL Map): одна на сервер, считается заранее в фоне — тысячи самых популярных
// тайтлов + всё из списков пользователей. Связи: продолжения, «похожее» сообщества AniList и
// сходство по содержанию (эмбеддинги); острова — сообщества Louvain с названиями от LLM.
// Личное (статусы, рекомендации) накладывается в браузере.

const POPULAR = 6000;
const FILE = () => path.join(env.dataDir, "atlas.json");
const REBUILD_AFTER = 7 * 86400;

const status: AtlasStatus = { state: "idle", phase: null, done: 0, total: 0, builtAt: null, error: null };
let atlas: Atlas | null = null;
let building: Promise<void> | null = null;

export function atlasStatus(): AtlasStatus {
  return { ...status, builtAt: loadAtlas()?.builtAt ?? null };
}

export function loadAtlas(): Atlas | null {
  if (atlas) return atlas;
  try {
    atlas = JSON.parse(fs.readFileSync(FILE(), "utf8")) as Atlas;
  } catch {
    atlas = null;
  }
  return atlas;
}

const POPULAR_QUERY = `
query ($page: Int, $format: MediaFormat, $below: Int) {
  Page(page: $page, perPage: 50) {
    media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, format: $format, popularity_lesser: $below) { id format popularity }
  }
}`;

type Pop = { id: number; format: string | null; popularity: number };
// AniList отдаёт по одному запросу не больше 5000 результатов — дальше добираем по форматам
const EXTRA_PAGES: [string, number][] = [["TV", 12], ["MOVIE", 5], ["ONA", 5], ["OVA", 5], ["SPECIAL", 3], ["TV_SHORT", 3]];

/** Самые популярные аниме AniList (без клипов), кэш на неделю. */
function popularIds(onPage: (n: number) => void): Promise<number[]> {
  return cached(`atlas-popular:v2:${POPULAR}`, 7 * 86400, async () => {
    const page = async (n: number, vars: object) =>
      (await gql<{ Page: { media: Pop[] } }>(POPULAR_QUERY, { page: n, ...vars })).Page.media;
    const main: Pop[] = [];
    for (let n = 1; n <= 100; n++) {
      const items = await page(n, {});
      main.push(...items);
      onPage(main.length);
      if (items.length < 50) break;
    }
    const all = new Map(main.map((m) => [m.id, m]));
    const below = main.at(-1)?.popularity;
    if (main.length >= 4950 && below) {
      for (const [format, pages] of EXTRA_PAGES) {
        for (let n = 1; n <= pages; n++) {
          const items = await page(n, { format, below });
          for (const m of items) all.set(m.id, m);
          onPage(all.size);
          if (items.length < 50) break;
        }
      }
    }
    return [...all.values()].filter((m) => m.format !== "MUSIC").sort((a, b) => b.popularity - a.popularity).slice(0, POPULAR).map((m) => m.id);
  });
}

/** Тайтлы из списков всех пользователей и их рекомендации: свои тайтлы должны быть на карте. */
function usersIds(): number[] {
  const ids = new Set(db.prepare<[], { anilist_id: number }>("SELECT DISTINCT anilist_id FROM list_entries").all().map((r) => r.anilist_id));
  for (const r of db.prepare<[], { recs: string | null }>("SELECT recs FROM user_taste").all()) {
    if (!r.recs) continue;
    for (const i of (JSON.parse(r.recs) as { items: { id: number }[] }).items.slice(0, 60)) ids.add(i.id);
  }
  return [...ids];
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const phase = (name: string, total = 0) => Object.assign(status, { phase: name, done: 0, total });

/** k ближайших по эмбеддингу (векторы нормированы — достаточно скалярного произведения), с паузами для сервера. */
async function nearest(vecs: Float32Array[], k: number, min: number): Promise<[number, number, number][]> {
  const out: [number, number, number][] = [];
  const dim = vecs[0]?.length ?? 0;
  for (let i = 0; i < vecs.length; i++) {
    const a = vecs[i];
    const best: [number, number][] = [];
    for (let j = 0; j < vecs.length; j++) {
      if (j === i) continue;
      const b = vecs[j];
      let s = 0;
      for (let d = 0; d < dim; d++) s += a[d] * b[d];
      if (s < min) continue;
      if (best.length < k) best.push([j, s]);
      else if (s > best[k - 1][1]) best[k - 1] = [j, s];
      else continue;
      best.sort((x, y) => y[1] - x[1]);
    }
    for (const [j, s] of best) out.push([i, j, s]);
    if (i % 40 === 0) { status.done = i; await tick(); }
  }
  return out;
}

async function build(): Promise<void> {
  // 1. Какие тайтлы
  phase("Популярные тайтлы AniList", POPULAR);
  const popular = await popularIds((n) => { status.done = n; });
  const own = usersIds();
  const ids = [...new Set([...popular, ...own])];

  // 2. Профили (данные AniList) и эмбеддинги — пачками, с прогрессом
  phase("Профили тайтлов", ids.length);
  for (let i = 0; i < ids.length; i += 100) {
    await ensureProfileData(ids.slice(i, i + 100));
    status.done = Math.min(ids.length, i + 100);
  }
  phase("Эмбеддинги", ids.length);
  for (let i = 0; i < ids.length; i += 64) {
    await quickEmbed(ids.slice(i, i + 64));
    status.done = Math.min(ids.length, i + 64);
  }
  const profiles = [...getProfiles(ids).values()].filter((p) => !p.data.isAdult || own.includes(p.data.id));
  const index = new Map(profiles.map((p, i) => [p.data.id, i]));

  // 3. Связи
  const edges = new Map<string, AtlasEdge>();
  const add = (a: number, b: number, w: number, kind: 0 | 1 | 2) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const e = edges.get(key);
    if (e) { e[2] += w; e[3] = Math.min(e[3], kind) as 0 | 1 | 2; } else edges.set(key, [Math.min(a, b), Math.max(a, b), w, kind]);
  };
  profiles.forEach((p, i) => {
    for (const r of p.data.relations) { const j = index.get(r.id); if (j !== undefined) add(i, j, 3, 0); }
    for (const r of p.data.recs.slice(0, 6)) { const j = index.get(r.id); if (j !== undefined) add(i, j, Math.min(2, Math.log1p(r.rating) / 2), 1); }
  });
  phase("Сходство по содержанию", profiles.length);
  const withVec = profiles.map((p, i) => [i, p.embedding] as const).filter((x): x is readonly [number, number[]] => Boolean(x[1]));
  const near = await nearest(withVec.map(([, v]) => Float32Array.from(v)), 4, 0.6);
  for (const [a, b, s] of near) add(withVec[a][0], withVec[b][0], (s - 0.55) * 4, 2);
  const edgeList = [...edges.values()];

  // 4. Острова: Louvain, мелкие сообщества — к соседнему острову
  phase("Острова", 0);
  const g = new Graph({ type: "undirected" });
  profiles.forEach((_, i) => g.addNode(String(i)));
  for (const [a, b, w] of edgeList) g.addEdge(String(a), String(b), { weight: w });
  const raw = louvain(g, { getEdgeWeight: "weight", resolution: 1.2 });
  const merged = mergeSmall(new Map(Object.entries(raw).map(([k, c]) => [Number(k), c])), edgeList.map(([a, b, w]) => [a, b, w]), 12);
  // Номера островов — по размеру; одиночки без связей — «острова» из одного тайтла не красим отдельно
  const sizes = new Map<number, number>();
  for (const c of merged.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const order = [...sizes].filter(([, n]) => n >= 12).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const remap = new Map(order.map((c, i) => [c, i]));
  const STRAY = order.length;
  const clusterOf = (i: number) => remap.get(merged.get(i)!) ?? STRAY;

  // 5. Раскладка в два уровня, как на карте: острова-круги с «морем» между ними (связанные — ближе),
  // внутри острова — своя ForceAtlas2, затем выравнивание плотности и расталкивание наложений
  phase("Раскладка", order.length + 1);
  const groups = new Map<number, number[]>();
  profiles.forEach((_, i) => { const c = clusterOf(i); groups.set(c, [...(groups.get(c) ?? []), i]); });
  const islandIds = [...groups.keys()].sort((x, y) => groups.get(y)!.length - groups.get(x)!.length);
  const slot = new Map(islandIds.map((c, k) => [c, k]));
  const radii = islandIds.map((c) => islandRadius(groups.get(c)!.length));
  const between = new Map<string, number>();
  for (const [a, b, w] of edgeList) {
    const ca = slot.get(clusterOf(a))!;
    const cb = slot.get(clusterOf(b))!;
    if (ca === cb) continue;
    const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
    between.set(key, (between.get(key) ?? 0) + w);
  }
  const maxLink = Math.max(1, ...between.values());
  const centers = packIslands(radii, new Map([...between].map(([k, w]) => [k, w / maxLink])), 70);
  const dots = profiles.map((p) => nodeSize(p.data.popularity));
  for (const c of islandIds) {
    const members = groups.get(c)!;
    const sub = new Graph({ type: "undirected" });
    members.forEach((i, k) => sub.addNode(String(i), { x: Math.cos(k * 2.4) * Math.sqrt(k + 1) * 10, y: Math.sin(k * 2.4) * Math.sqrt(k + 1) * 10 }));
    for (const [a, b, w] of edgeList) {
      if (sub.hasNode(String(a)) && sub.hasNode(String(b)) && !sub.hasEdge(String(a), String(b))) sub.addEdge(String(a), String(b), { weight: w });
    }
    if (members.length > 2) {
      forceAtlas2.assign(sub, {
        iterations: members.length > 150 ? 250 : 350, getEdgeWeight: "weight",
        settings: { ...forceAtlas2.inferSettings(sub), barnesHutOptimize: members.length > 200, gravity: 1.5, scalingRatio: 4 },
      });
    }
    const local = shapeIsland(members.map((i) => sub.getNodeAttributes(String(i)) as { x: number; y: number }), radii[slot.get(c)!]);
    relaxOverlaps(local, members.map((i) => dots[i]), 2);
    const center = centers[slot.get(c)!];
    members.forEach((i, k) => g.mergeNodeAttributes(String(i), { x: center.x + local[k].x, y: center.y + local[k].y, size: dots[i] }));
    status.done++;
    await tick();
  }

  // 6. Названия островов
  const members = new Map<number, Profile[]>();
  profiles.forEach((p, i) => { const c = clusterOf(i); members.set(c, [...(members.get(c) ?? []), p]); });
  const globalFreq = new Map([...countTags(profiles)].map(([t, n]) => [t, n / profiles.length]));
  const colors = clusterColors(order.length);
  const clusters: AtlasCluster[] = [];
  phase("Названия островов", order.length);
  for (let c = 0; c < order.length; c++) {
    const list = members.get(c) ?? [];
    const pts = list.map((p) => g.getNodeAttributes(String(index.get(p.data.id))) as { x: number; y: number });
    clusters.push({
      id: c,
      name: await uniqueName(list, globalFreq, clusters.map((x) => x.name)),
      color: colors[c],
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      size: list.length,
      top: [...list].sort((a, b) => b.data.popularity - a.data.popularity).slice(0, 5).map((p) => p.data.titleRu ?? p.data.title),
    });
    status.done = c + 1;
  }

  const nodes: AtlasNode[] = profiles.map((p, i) => {
    const a = g.getNodeAttributes(String(i)) as { x: number; y: number; size: number };
    return {
      id: p.data.id, label: p.data.titleRu ?? p.data.title, x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10, size: a.size,
      cluster: clusterOf(i), popularity: p.data.popularity, score: p.data.score, year: p.data.year, format: p.data.format,
      episodes: p.data.episodes, genres: p.data.genres.slice(0, 4), cover: p.data.cover,
    };
  });
  const result: Atlas = { builtAt: now(), nodes, edges: edgeList.map(([a, b, w, k]) => [a, b, Math.round(w * 100) / 100, k]), clusters };
  fs.writeFileSync(FILE(), JSON.stringify(result));
  atlas = result;
}

/** Пересобрать карту (одна сборка за раз). */
export function rebuildAtlas(): Promise<void> {
  if (building) return building;
  Object.assign(status, { state: "building", error: null });
  building = build()
    .then(() => Object.assign(status, { state: "idle", phase: null }))
    .catch((e) => { console.warn(`[atlas] ${String(e)}`); Object.assign(status, { state: "error", error: String(e) }); })
    .then(() => { building = null; });
  return building;
}

/** Фоновая проверка: карты нет, она старше недели или на ней нет многих тайтлов из списков. */
export function maybeRebuildAtlas(): void {
  const a = loadAtlas();
  if (!a) return void rebuildAtlas();
  const on = new Set(a.nodes.map((n) => n.id));
  const missing = usersIds().filter((id) => !on.has(id)).length;
  if (a.builtAt < now() - REBUILD_AFTER || missing >= 30) void rebuildAtlas();
}
