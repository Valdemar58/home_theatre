"use client";
import { AdjustmentsHorizontalIcon, ArrowPathIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Graph from "graphology";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type Sigma from "sigma";
import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import { islandBlobs, simStep, type Atlas, type AtlasNode, type AtlasStatus, type SimLink, type SimNode } from "@/lib/atlas";
import { api, useAnime, useList, useMe } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { FORMAT_LABELS, GENRE_LABELS, LIST_LABELS, label } from "@/lib/labels";
import type { ListEntry, ListStatus } from "@/lib/types";
import { ListControl } from "./ListControl";
import { MatchBadge } from "./MatchBadge";
import { Button, cx, ErrorBox, Skel, Spinner } from "./ui";

// Карта тайтлов (как MAL Map): раскладка готова заранее — открывается сразу, без тряски.
// Острова — сообщества похожих тайтлов; мои тайтлы — кольцо цвета статуса; подписи появляются при приближении.
// Перетаскивание — «резиной»: соседи тянутся следом и всё возвращается на место.

type MapResponse = { atlas: Atlas | null; status: AtlasStatus; recs: number[] };

const BG = "#030712"; // gray-950
type StatusKey = ListStatus | "none";
const STATUS_TONE: Record<ListStatus, string> = {
  watching: "info", rewatching: "info", completed: "positive", planned: "accent", on_hold: "warning", dropped: "negative",
};
const STATUS_FILTERS: [StatusKey, string][] = [
  ["watching", "Смотрю"], ["completed", "Просмотрено"], ["planned", "В планах"], ["on_hold", "Отложено"], ["dropped", "Брошено"], ["none", "Не в списке"],
];
const FORMAT_GROUPS: [string, string, (f: string | null) => boolean][] = [
  ["tv", "Сериалы", (f) => f === "TV" || f === "TV_SHORT"],
  ["movie", "Фильмы", (f) => f === "MOVIE"],
  ["other", "OVA / ONA / спешлы", (f) => !f || !["TV", "TV_SHORT", "MOVIE"].includes(f)],
];

type Filters = { statuses: StatusKey[]; formats: string[]; genre: string; yearFrom: string; yearTo: string; recs: boolean };
const NO_FILTERS: Filters = { statuses: [], formats: [], genre: "", yearFrom: "", yearTo: "", recs: false };

// ---------------------------------------------------------------- цвета

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Смешать цвет с фоном: t = 0 — как есть, 1 — фон */
function fade(hex: string, t: number): string {
  const a = hexRgb(hex);
  const b = hexRgb(BG);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
const rgba = (hex: string, alpha: number) => `rgba(${hexRgb(hex).join(",")},${alpha})`;

/** Цвет тона палитры в hex: WebGL-рендереру нужен hex, а палитра — в oklch */
function toneHex(tone: string): string {
  const el = document.createElement("span");
  el.style.color = `var(--color-${tone}-400)`;
  document.body.appendChild(el);
  const css = getComputedStyle(el).color;
  el.remove();
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- подписи

const drawLabel: NodeLabelDrawingFunction = (ctx, data) => {
  if (!data.label) return;
  const text = data.label.length > 34 ? `${data.label.slice(0, 32).trimEnd()}…` : data.label;
  const size = Math.round(12 + Math.min(4, Math.max(0, data.size - 6) * 0.35));
  ctx.font = `500 ${size}px Inter, sans-serif`;
  const x = data.x + data.size + 4;
  const y = data.y + size / 3;
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(3,7,18,0.95)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#f3f4f6";
  ctx.fillText(text, x, y);
};

/** Наведение: только светлое кольцо и подпись — подробности в карточке */
const drawHover: NodeHoverDrawingFunction = (ctx, data, settings) => {
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  drawLabel(ctx, data, settings);
};

// ---------------------------------------------------------------- карта

export function MapView() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, error, isLoading } = useQuery({ queryKey: ["map"], queryFn: () => api<MapResponse>("/api/map"), staleTime: 60 * 60_000 });
  const building = data?.status.state === "building";
  const { data: live } = useQuery({
    queryKey: ["map-status"], queryFn: () => api<AtlasStatus>("/api/map/status"),
    enabled: building, refetchInterval: building ? 2500 : false,
  });
  // Сборка закончилась — забрать карту
  useEffect(() => {
    if (building && live && live.state !== "building") void qc.invalidateQueries({ queryKey: ["map"] });
  }, [building, live, qc]);

  const atlas = data?.atlas ?? null;
  const { byId: myList } = useList();
  const recs = useMemo(() => new Set(data?.recs ?? []), [data]);
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ready, setReady] = useState(0);
  const [hover, setHover] = useState<{ node: AtlasNode; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<AtlasNode | null>(null);
  const [island, setIsland] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState(true);

  const byKey = useMemo(() => new Map((atlas?.nodes ?? []).map((n) => [String(n.id), n])), [atlas]);
  const clusterById = useMemo(() => new Map((atlas?.clusters ?? []).map((c) => [c.id, c])), [atlas]);
  const genres = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of atlas?.nodes ?? []) for (const g of n.genres) count.set(g, (count.get(g) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  }, [atlas]);

  // Подходящие под фильтры (null — фильтров нет)
  const matched = useMemo(() => {
    const f = filters;
    const active = f.statuses.length || f.formats.length || f.genre || f.yearFrom || f.yearTo || f.recs;
    if (!atlas || !active) return null;
    const from = Number(f.yearFrom) || 0;
    const to = Number(f.yearTo) || 9999;
    const set = new Set<string>();
    for (const n of atlas.nodes) {
      const e = myList.get(n.id);
      const st: StatusKey = e ? (e.status === "rewatching" ? "watching" : e.status) : "none";
      if (f.statuses.length && !f.statuses.includes(st)) continue;
      if (f.formats.length && !FORMAT_GROUPS.some(([k, , test]) => f.formats.includes(k) && test(n.format))) continue;
      if (f.genre && !n.genres.includes(f.genre)) continue;
      if ((f.yearFrom || f.yearTo) && (!n.year || n.year < from || n.year > to)) continue;
      if (f.recs && !recs.has(n.id)) continue;
      set.add(String(n.id));
    }
    return set;
  }, [atlas, filters, myList, recs]);

  const q = query.trim().toLowerCase();
  const found = useMemo(() => (q.length >= 2 ? (atlas?.nodes ?? []).filter((n) => n.label.toLowerCase().includes(q)).sort((a, b) => b.popularity - a.popularity) : []), [atlas, q]);

  // Состояние, которое читают редьюсеры и слои (без пересоздания рендерера)
  const view = useRef({
    island: null as number | null, matched: null as Set<string> | null, found: new Set<string>(),
    mine: new Map<string, string>(), dim: new Map<string, number>(), zoomed: false,
    /** Узлы, которые сейчас двигает физика: в sigma скрыты, рисуются на оверлее */
    sim: null as Set<string> | null,
  });
  const labelsLayer = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- рендерер (один раз на карту)
  useEffect(() => {
    if (!atlas || !container.current) return;
    let disposed = false;
    const v = view.current;
    const g = new Graph({ type: "undirected" });
    const colorOf = new Map(atlas.clusters.map((c) => [c.id, c.color]));
    const STRAY = "#6b7280";
    const islandOf = new Map<number, string[]>();
    for (const n of atlas.nodes) {
      const key = String(n.id);
      g.addNode(key, { x: n.x, y: n.y, size: n.size, label: n.label, color: colorOf.get(n.cluster) ?? STRAY, cluster: n.cluster });
      islandOf.set(n.cluster, [...(islandOf.get(n.cluster) ?? []), key]);
    }
    for (const [a, b, w, kind] of atlas.edges) {
      const s = String(atlas.nodes[a].id);
      const t = String(atlas.nodes[b].id);
      if (g.hasEdge(s, t)) continue;
      // Сила связи 0–1: продолжения — максимум, «похожее» и сходство — по весу
      const strength = kind === 0 ? 1 : Math.min(1, w / 2.5);
      g.addEdge(s, t, {
        s, t, weight: w, kind, strength, same: atlas.nodes[a].cluster === atlas.nodes[b].cluster,
        size: 0.4 + strength * 1.4,
        // Прозрачность цвета рёбер WebGL-рендерер не учитывает — смешиваем с фоном сами: сильные ярче
        color: fade(colorOf.get(atlas.nodes[a].cluster) ?? STRAY, 0.9 - strength * 0.45),
      });
    }
    graphRef.current = g;
    const labelBox = new Map<number, [number, number]>();
    let renderer: Sigma | null = null;
    let overlay: HTMLCanvasElement | null = null;

    // Фокус (наведение/выбор): затемнение и связи рисуются на оверлее — sigma не пересчитывает 20 тыс. рёбер
    const focus = { key: null as string | null, t: 0, target: 0, nb: [] as { key: string; strength: number }[], top: new Set<string>() };
    // Физика перетаскивания
    let sim: { keys: string[]; nodes: SimNode[]; links: SimLink[]; edges: [number, number, number][]; dragged: number; alpha: number; dragging: boolean } | null = null;
    let raf = 0;

    const prep = (cv: HTMLCanvasElement) => {
      const pr = window.devicePixelRatio || 1;
      const { width, height } = renderer!.getDimensions();
      if (cv.width !== Math.round(width * pr) || cv.height !== Math.round(height * pr)) {
        cv.width = Math.round(width * pr);
        cv.height = Math.round(height * pr);
        cv.style.width = `${width}px`;
        cv.style.height = `${height}px`;
      }
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(pr, 0, 0, pr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      return ctx;
    };
    const vp = (x: number, y: number) => renderer!.graphToViewport({ x, y });
    const px = (size: number) => renderer!.scaleSize(size);

    /** Оверлей: затемнение + связи и соседи фокуса; узлы, которые двигает физика */
    const drawOverlay = () => {
      if (!renderer || !overlay) return;
      const ctx = prep(overlay);
      const { width, height } = renderer.getDimensions();
      const t = focus.t;
      if (labelsLayer.current) labelsLayer.current.style.opacity = String(1 - 0.85 * t);
      if (t > 0 && focus.key) {
        ctx.fillStyle = rgba(BG, 0.8 * t);
        ctx.fillRect(0, 0, width, height);
        const f = g.getNodeAttributes(focus.key);
        const fp = vp(f.x, f.y);
        for (const n of focus.nb) {
          const a = g.getNodeAttributes(n.key);
          const p = vp(a.x, a.y);
          ctx.beginPath();
          ctx.moveTo(fp.x, fp.y);
          ctx.lineTo(p.x, p.y);
          ctx.lineWidth = 0.6 + n.strength * 2.2;
          ctx.strokeStyle = rgba("#e2e8f0", (0.12 + n.strength * 0.55) * t);
          ctx.stroke();
        }
        ctx.globalAlpha = t;
        for (const n of [...focus.nb.map((x) => x.key), focus.key]) {
          const a = g.getNodeAttributes(n);
          const p = vp(a.x, a.y);
          const r = Math.max(2, px(a.size));
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = a.color;
          ctx.fill();
          const ring = v.mine.get(n);
          if (ring) { ctx.lineWidth = 2; ctx.strokeStyle = ring; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke(); }
        }
        for (const n of focus.top) {
          const a = g.getNodeAttributes(n);
          const p = vp(a.x, a.y);
          drawLabel(ctx, { ...a, x: p.x, y: p.y, size: Math.max(2, px(a.size)), key: n } as never, renderer.getSettings());
        }
        ctx.globalAlpha = 1;
      }
      if (sim) {
        for (const [a, b, strength] of sim.edges) {
          const p = vp(sim.nodes[a].x, sim.nodes[a].y);
          const q = vp(sim.nodes[b].x, sim.nodes[b].y);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.lineWidth = 0.5 + strength * 1.8;
          ctx.strokeStyle = rgba("#cbd5e1", 0.12 + strength * 0.45);
          ctx.stroke();
        }
        sim.keys.forEach((key, i) => {
          const a = g.getNodeAttributes(key);
          const n = sim!.nodes[i];
          const p = vp(n.x, n.y);
          const r = Math.max(2, px(a.size));
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = a.color;
          ctx.fill();
          const ring = v.mine.get(key);
          if (ring) { ctx.lineWidth = 2; ctx.strokeStyle = ring; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); ctx.stroke(); }
          if (i === sim!.dragged || r >= 6) drawLabel(ctx, { ...a, x: p.x, y: p.y, size: r, key } as never, renderer!.getSettings());
        });
      }
    };

    /** Один цикл анимации на всё: плавный фокус и физика; sigma при этом не перерисовывается */
    const tick = () => {
      raf = 0;
      let again = false;
      if (focus.t !== focus.target) {
        focus.t += (focus.target - focus.t) * 0.25;
        if (Math.abs(focus.target - focus.t) < 0.02) focus.t = focus.target;
        if (focus.t === 0) focus.key = null;
        again = true;
      }
      if (sim) {
        if (!sim.dragging) sim.alpha *= 0.95;
        const energy = simStep(sim.nodes, sim.links, sim.alpha);
        if (!sim.dragging && (sim.alpha < 0.03 || energy < 0.02)) commitSim();
        else again = true;
      }
      drawOverlay();
      if (again) raf = requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    const setFocus = (key: string | null) => {
      if (key && g.hasNode(key)) {
        focus.key = key;
        focus.nb = g.edges(key).map((e) => ({ key: g.opposite(key, e), strength: g.getEdgeAttribute(e, "strength") as number }));
        // Подписываем только сильнейших соседей — иначе у популярного тайтла подписи сливаются
        focus.top = new Set([key, ...neighborsOf(g, key)]);
        focus.target = 1;
      } else focus.target = 0;
      kick();
    };
    focusRef.current = setFocus;

    /** Физика закончилась: новые места — в граф (один пересчёт sigma), узлы снова рисует sigma */
    const commitSim = () => {
      if (!sim) return;
      sim.keys.forEach((key, i) => g.mergeNodeAttributes(key, { x: sim!.nodes[i].x, y: sim!.nodes[i].y }));
      sim = null;
      v.sim = null;
      renderer?.refresh();
    };

    void import("sigma").then(({ default: SigmaCtor }) => {
      if (disposed || !container.current) return;
      const r = new SigmaCtor(g, container.current, {
        defaultDrawNodeLabel: drawLabel,
        defaultDrawNodeHover: drawHover,
        // Размеры — в единицах карты: издалека точки мелкие, при приближении растут (как на карте)
        itemSizesReference: "positions",
        zoomToSizeRatioFunction: (ratio) => ratio,
        labelRenderedSizeThreshold: 7,
        labelDensity: 0.5,
        labelGridCellSize: 150,
        hideEdgesOnMove: true,
        zIndex: true,
        minCameraRatio: 0.05,
        maxCameraRatio: 2,
        stagePadding: 40,
      });
      renderer = r;

      // Редьюсеры — только для того, что меняется редко: фильтры, остров, поиск, перетаскиваемые узлы
      r.setSetting("nodeReducer", (node, attrs) => {
        const res = { ...attrs };
        if (v.sim?.has(node)) { res.hidden = true; return res; }
        let dim = 0;
        if (v.matched && !v.matched.has(node)) dim = 0.82;
        if (v.island !== null && attrs.cluster !== v.island) dim = Math.max(dim, 0.75);
        v.dim.set(node, dim);
        if (dim) res.color = fade(attrs.color as string, dim);
        if (dim > 0.5) { res.label = null; res.zIndex = 0; } else res.zIndex = 1;
        if (v.found.has(node) || (v.matched && v.matched.size <= 40 && v.matched.has(node))) { res.forceLabel = true; res.zIndex = 2; }
        if (v.mine.has(node)) res.size = (attrs.size as number) * 1.15;
        return res;
      });
      r.setSetting("edgeReducer", (_edge, attrs) => {
        const res = { ...attrs };
        const s = attrs.s as string;
        const t = attrs.t as string;
        // Издалека связей нет, ближе — внутри острова (между островами — при наведении)
        if (!v.zoomed || !attrs.same || v.sim?.has(s) || v.sim?.has(t) || (v.dim.get(s) ?? 0) > 0.5 || (v.dim.get(t) ?? 0) > 0.5) res.hidden = true;
        return res;
      });

      // Слои: «туман» островов (под рёбрами), кольца моих тайтлов (над точками), оверлей (над подписями)
      const opts = (o: object) => o as { style?: Partial<CSSStyleDeclaration> };
      const islands = r.createCanvas("islands", opts({ beforeLayer: "edges" }));
      const rings = r.createCanvas("rings", opts({ afterLayer: "nodes" }));
      overlay = r.createCanvas("overlay", opts({ afterLayer: "labels" }));

      // «Туман» рисуется один раз в картинку (в координатах карты), дальше только масштабируется
      let fog: { cv: HTMLCanvasElement; island: number | null; minX: number; maxX: number; minY: number; maxY: number } | null = null;
      const buildFog = () => {
        const blobs = islandBlobs([...g.nodes()].map((k) => g.getNodeAttributes(k) as { x: number; y: number; cluster: number }), 70);
        const minX = Math.min(...blobs.map((b) => b[0] - b[2]));
        const maxX = Math.max(...blobs.map((b) => b[0] + b[2]));
        const minY = Math.min(...blobs.map((b) => b[1] - b[2]));
        const maxY = Math.max(...blobs.map((b) => b[1] + b[2]));
        const scale = 1600 / Math.max(maxX - minX, maxY - minY);
        const cv = document.createElement("canvas");
        cv.width = Math.ceil((maxX - minX) * scale);
        cv.height = Math.ceil((maxY - minY) * scale);
        const ctx = cv.getContext("2d")!;
        for (const [x, y, rad, c] of blobs) {
          // Строка 0 картинки — верх карты (maxY)
          const cx = (x - minX) * scale;
          const cy = (maxY - y) * scale;
          const rr = rad * scale;
          const color = colorOf.get(c) ?? STRAY;
          const k = v.island !== null && c !== v.island ? 0.25 : 1;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
          grad.addColorStop(0, rgba(color, 0.14 * k));
          grad.addColorStop(1, rgba(color, 0));
          ctx.fillStyle = grad;
          ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
        }
        fog = { cv, island: v.island, minX, maxX, minY, maxY };
      };

      const drawLayers = () => {
        const ctx = prep(islands);
        if (!fog || fog.island !== v.island) buildFog();
        const ratio = r.getCamera().ratio;
        const tl = vp(fog!.minX, fog!.maxY);
        const br = vp(fog!.maxX, fog!.minY);
        // Вблизи «туман» приглушаем: он нужен для общего вида
        ctx.globalAlpha = Math.min(1, 0.3 + ratio);
        if (tl.y <= br.y) ctx.drawImage(fog!.cv, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        else {
          ctx.translate(0, tl.y + br.y);
          ctx.scale(1, -1);
          ctx.drawImage(fog!.cv, tl.x, br.y, br.x - tl.x, tl.y - br.y);
        }
        const rc = prep(rings);
        for (const [key, color] of v.mine) {
          if (v.sim?.has(key)) continue;
          const d = r.getNodeDisplayData(key);
          if (!d || d.hidden) continue;
          const a = g.getNodeAttributes(key);
          const p = vp(a.x, a.y);
          const rad = px(d.size) + 2;
          const dim = v.dim.get(key) ?? 0;
          rc.beginPath();
          rc.arc(p.x, p.y, rad, 0, Math.PI * 2);
          rc.lineWidth = rad > 6 ? 2 : 1.5;
          rc.strokeStyle = rgba(color, 1 - dim * 0.9);
          rc.stroke();
        }
        // Названия островов: видны издалека, при приближении тают; налезающие на крупные — прячутся
        const op = Math.max(0, Math.min(1, (ratio - 0.4) / 0.25));
        const placed: [number, number, number, number][] = [];
        atlas.clusters.forEach((c, i) => {
          const el = labelRefs.current[i];
          if (!el) return;
          const p = vp(c.x, c.y);
          let box = labelBox.get(i);
          if (!box || !box[0]) { box = [el.offsetWidth, el.offsetHeight]; labelBox.set(i, box); }
          const rect: [number, number, number, number] = [p.x - box[0] / 2 - 4, p.y - box[1] / 2 - 4, p.x + box[0] / 2 + 4, p.y + box[1] / 2 + 4];
          const focused = v.island === c.id;
          const clash = !focused && placed.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1]);
          if (!clash && op > 0) placed.push(rect);
          const shown = clash ? 0 : v.island === null || focused ? op : op * 0.15;
          el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
          el.style.opacity = String(focused ? Math.max(shown, 0.9) : shown);
        });
        drawOverlay();
      };
      r.on("afterRender", drawLayers);
      r.getCamera().on("updated", ({ ratio }) => {
        const zoomed = ratio < 0.4;
        if (zoomed !== v.zoomed) { v.zoomed = zoomed; r.refresh(); }
      });

      // Наведение и выбор
      r.on("enterNode", ({ node }) => {
        if (sim) return;
        const n = byKey.get(node);
        if (!n) return;
        const a = g.getNodeAttributes(node);
        const p = vp(a.x, a.y);
        setHover({ node: n, x: p.x, y: p.y });
        setFocus(node);
        container.current!.style.cursor = "pointer";
      });
      r.on("leaveNode", () => {
        if (sim?.dragging) return;
        setHover(null);
        setFocus(selectedRef.current);
        container.current!.style.cursor = "";
      });
      r.on("clickNode", ({ node }) => {
        if (moved) return;
        setSelected(byKey.get(node) ?? null);
        selectedRef.current = node;
      });
      r.on("clickStage", () => {
        if (moved) return;
        setSelected(null);
        selectedRef.current = null;
        setFocus(null);
      });

      // Перетаскивание как в Obsidian: соседи по острову (1–2 шага) тянутся по пружинам связей
      // (сильные — сильнее), расталкиваются, после отпускания всё остывает и остаётся, где легло
      let moved = false;
      // Нажали на узел — пока это может быть и клик: физику запускаем, только когда мышь сдвинулась
      let pending: { node: string; x: number; y: number } | null = null;
      r.on("downNode", ({ node, event }) => {
        event.preventSigmaDefault();
        moved = false;
        pending = { node, x: event.x, y: event.y };
      });
      const startDrag = (node: string) => {
        if (sim) commitSim();
        if (!r.getCustomBBox()) r.setCustomBBox(r.getBBox());
        const cluster = g.getNodeAttribute(node, "cluster") as number;
        const local = (k: string) => g.getNodeAttribute(k, "cluster") === cluster;
        const byStrength = (k: string) => g.edges(k)
          .map((e) => ({ o: g.opposite(k, e), s: g.getEdgeAttribute(e, "strength") as number }))
          .filter((x) => local(x.o)).sort((a, b) => b.s - a.s).map((x) => x.o);
        const movable = [node];
        const seen = new Set(movable);
        for (const k of byStrength(node).slice(0, 40)) if (!seen.has(k)) { seen.add(k); movable.push(k); }
        for (const k of movable.slice(1)) for (const m of byStrength(k).slice(0, 4)) if (!seen.has(m) && movable.length < 110) { seen.add(m); movable.push(m); }
        // Опоры — остальной остров: держат связи и не дают налезать
        const anchors = (islandOf.get(cluster) ?? []).filter((k) => !seen.has(k));
        const keys = [...movable, ...anchors];
        const index = new Map(keys.map((k, i) => [k, i]));
        const nodes: SimNode[] = keys.map((k, i) => {
          const a = g.getNodeAttributes(k);
          return { x: a.x, y: a.y, vx: 0, vy: 0, r: a.size as number, fixed: i === 0 || i >= movable.length };
        });
        const links: SimLink[] = [];
        const edges: [number, number, number][] = [];
        for (const k of movable) {
          for (const e of g.edges(k)) {
            const o = g.opposite(k, e);
            const j = index.get(o);
            if (j === undefined || (j < movable.length && o < k)) continue;
            const i = index.get(k)!;
            const strength = g.getEdgeAttribute(e, "strength") as number;
            links.push({ a: i, b: j, rest: Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y), k: 0.015 + strength * 0.09 });
            edges.push([i, j, strength]);
          }
        }
        sim = { keys: movable, nodes, links, edges, dragged: 0, alpha: 1, dragging: true };
        v.sim = new Set(movable);
        setHover(null);
        focus.target = 0;
        focus.t = 0;
        r.refresh();
        kick();
      };
      r.on("moveBody", ({ event }) => {
        if (pending) {
          if (Math.hypot(event.x - pending.x, event.y - pending.y) < 4) {
            event.preventSigmaDefault();
            return;
          }
          startDrag(pending.node);
          pending = null;
        }
        if (!sim?.dragging) return;
        moved = true;
        const p = r.viewportToGraph(event);
        sim.nodes[0].x = p.x;
        sim.nodes[0].y = p.y;
        sim.alpha = 1;
        kick();
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      });
      const release = () => {
        pending = null;
        if (!sim?.dragging) return;
        sim.dragging = false;
        // Отпущенный узел свободен: его, как в Obsidian, чуть подтягивают связи
        sim.nodes[0].fixed = false;
        kick();
        setTimeout(() => { moved = false; }, 0);
      };
      r.on("upNode", release);
      r.on("upStage", release);

      // Панель слева закрывает край — центр карты сдвигаем в видимую часть
      const { width } = r.getDimensions();
      if (width > 900) r.getCamera().setState({ x: 0.5 - 170 / width, y: 0.5, ratio: 1.08 });
      sigmaRef.current = r;
      setReady((n) => n + 1);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      sigmaRef.current?.kill();
      sigmaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlas, byKey]);

  const focusRef = useRef<(node: string | null) => void>(() => {});
  const selectedRef = useRef<string | null>(null);

  // Личное поверх карты и фильтры → в состояние редьюсеров
  useEffect(() => {
    const v = view.current;
    const mine = new Map<string, string>();
    const tones = Object.fromEntries(Object.entries(STATUS_TONE).map(([s, t]) => [s, toneHex(t)]));
    for (const [id, e] of myList) mine.set(String(id), tones[e.status]);
    v.mine = mine;
    v.matched = matched;
    v.island = island;
    v.found = new Set(found.slice(0, 12).map((n) => String(n.id)));
    sigmaRef.current?.refresh();
  }, [myList, matched, island, found, ready]);

  // Камера
  const flyTo = (keys: string[], ratio: number) => {
    const r = sigmaRef.current;
    if (!r || !keys.length) return;
    const pts = keys.map((k) => r.getNodeDisplayData(k)).filter(Boolean) as { x: number; y: number }[];
    if (!pts.length) return;
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    void r.getCamera().animate({ x, y, ratio }, { duration: 700, easing: "cubicInOut" });
  };
  const pick = (n: AtlasNode) => {
    setSelected(n);
    selectedRef.current = String(n.id);
    focusRef.current(String(n.id));
    flyTo([String(n.id)], 0.12);
    setQuery("");
  };
  const chooseIsland = (id: number | null) => {
    setIsland(id);
    if (id !== null && atlas) flyTo(atlas.nodes.filter((n) => n.cluster === id).map((n) => String(n.id)), 0.35);
    else void sigmaRef.current?.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 600 });
  };

  const filterCount = filters.statuses.length + filters.formats.length + (filters.genre ? 1 : 0) + (filters.yearFrom || filters.yearTo ? 1 : 0) + (filters.recs ? 1 : 0);
  const toggle = <K extends "statuses" | "formats">(key: K, value: Filters[K][number]) =>
    setFilters((f) => ({ ...f, [key]: (f[key] as string[]).includes(value) ? (f[key] as string[]).filter((x) => x !== value) : [...f[key], value] }));

  // Карта грузится: панель с фильтрами уже настоящая (выбор применится, когда карта придёт),
  // счётчики, жанры и острова — заглушками; на месте карты — пульсирующее пятно
  if (isLoading) return (
    <Shell>
      <Skel className="absolute left-1/2 top-1/2 h-[60%] w-[60%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-30 blur-2xl" />
      <div aria-busy className="absolute left-3 top-3 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-xl bg-gray-900/90 shadow-xl ring-1 ring-gray-700 backdrop-blur">
        <div className="flex items-center gap-2 p-3">
          <span className="rounded-md p-1 text-gray-400"><AdjustmentsHorizontalIcon className="h-5 w-5" /></span>
          <h1 className="mr-auto font-bold">Карта аниме</h1>
          {filterCount > 0 && <button onClick={() => setFilters(NO_FILTERS)} className="text-xs text-accent-300 hover:text-accent-200">Сбросить ({filterCount})</button>}
        </div>
        <div className="space-y-4 overflow-y-auto px-3 pb-3">
          <Skel className="h-4 w-56" />
          <Skel className="h-8 w-full" />
          <Group title="Мой список">
            {STATUS_FILTERS.map(([k, name]) => (
              <Chip key={k} on={filters.statuses.includes(k)} onClick={() => toggle("statuses", k)}
                dot={k === "none" ? undefined : `var(--color-${STATUS_TONE[k as ListStatus]}-400)`}>{name}</Chip>
            ))}
            <Chip on={filters.recs} onClick={() => setFilters((f) => ({ ...f, recs: !f.recs }))}>Рекомендации мне</Chip>
          </Group>
          <Group title="Формат">
            {FORMAT_GROUPS.map(([k, name]) => <Chip key={k} on={filters.formats.includes(k)} onClick={() => toggle("formats", k)}>{name}</Chip>)}
          </Group>
          <Skel className="h-8 w-full" />
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Острова</p>
            <div className="space-y-1.5">{Array.from({ length: 8 }, (_, i) => <Skel key={i} className={cx("h-5", i % 3 ? "w-2/3" : "w-full")} />)}</div>
          </div>
        </div>
      </div>
    </Shell>
  );
  if (error) return <Shell><div className="p-6"><ErrorBox error={error} /></div></Shell>;
  const st = live ?? data!.status;
  if (!atlas) return <Shell><Progress status={st} admin={Boolean(me?.isAdmin)} /></Shell>;

  const mineOnMap = atlas.nodes.filter((n) => myList.has(n.id)).length;

  return (
    <Shell>
      <div ref={container} className="absolute inset-0 animate-[fade-in_0.6s_ease-out]" />

      {/* Названия островов: тёмная плашка — читается поверх точек и «тумана» */}
      <div ref={labelsLayer} className="pointer-events-none absolute inset-0 overflow-hidden">
        {atlas.clusters.map((c, i) => (
          <div key={c.id} ref={(el) => { labelRefs.current[i] = el; }}
            className="absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-gray-950/75 px-2.5 py-1 font-semibold text-gray-100 ring-1 ring-white/10 transition-opacity duration-300 will-change-transform"
            style={{ fontSize: Math.round(12 + Math.min(4, Math.sqrt(c.size) * 0.25)) }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} />
            {c.name}
          </div>
        ))}
      </div>

      {/* Панель: поиск, фильтры, острова */}
      <div className={cx("absolute left-3 top-3 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-xl bg-gray-900/90 shadow-xl ring-1 ring-gray-700 backdrop-blur transition", !panel && "w-auto")}>
        <div className="flex items-center gap-2 p-3">
          <button onClick={() => setPanel((p) => !p)} className="rounded-md p-1 text-gray-400 hover:bg-gray-800 hover:text-white" title={panel ? "Свернуть" : "Фильтры и острова"}>
            <AdjustmentsHorizontalIcon className="h-5 w-5" />
          </button>
          {panel && <h1 className="mr-auto font-bold">Карта аниме</h1>}
          {panel && filterCount > 0 && <button onClick={() => setFilters(NO_FILTERS)} className="text-xs text-accent-300 hover:text-accent-200">Сбросить ({filterCount})</button>}
        </div>
        {panel && (
          <div className="space-y-4 overflow-y-auto px-3 pb-3">
            <p className="text-xs text-gray-500">{atlas.nodes.length.toLocaleString("ru-RU")} тайтлов · {atlas.clusters.length} островов · моих на карте — {mineOnMap}</p>
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-gray-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти на карте"
                onKeyDown={(e) => { if (e.key === "Enter" && found[0]) pick(found[0]); }}
                className="w-full rounded-md border border-gray-700 bg-gray-800 py-1.5 pl-8 pr-2 text-sm focus:border-accent-500 focus:outline-none" />
              {found.length > 0 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg bg-gray-900 py-1 shadow-2xl ring-1 ring-gray-700">
                  {found.slice(0, 10).map((n) => (
                    <button key={n.id} onClick={() => pick(n)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-gray-800">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: clusterById.get(n.cluster)?.color ?? "#6b7280" }} />
                      <span className="min-w-0 flex-1 truncate">{n.label}</span>
                      <span className="text-xs text-gray-500">{n.year}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Group title="Мой список">
              {STATUS_FILTERS.map(([k, name]) => (
                <Chip key={k} on={filters.statuses.includes(k)} onClick={() => toggle("statuses", k)}
                  dot={k === "none" ? undefined : `var(--color-${STATUS_TONE[k as ListStatus]}-400)`}>{name}</Chip>
              ))}
              <Chip on={filters.recs} onClick={() => setFilters((f) => ({ ...f, recs: !f.recs }))}>Рекомендации мне</Chip>
            </Group>
            <Group title="Формат">
              {FORMAT_GROUPS.map(([k, name]) => <Chip key={k} on={filters.formats.includes(k)} onClick={() => toggle("formats", k)}>{name}</Chip>)}
            </Group>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select value={filters.genre} onChange={(e) => setFilters((f) => ({ ...f, genre: e.target.value }))}
                className="min-w-0 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm">
                <option value="">Любой жанр</option>
                {genres.map((g) => <option key={g} value={g}>{GENRE_LABELS[g] ?? g}</option>)}
              </select>
              <div className="flex items-center gap-1 text-sm">
                <input value={filters.yearFrom} onChange={(e) => setFilters((f) => ({ ...f, yearFrom: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder="с"
                  className="w-14 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5" inputMode="numeric" />
                <span className="text-gray-500">–</span>
                <input value={filters.yearTo} onChange={(e) => setFilters((f) => ({ ...f, yearTo: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder="по"
                  className="w-14 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5" inputMode="numeric" />
              </div>
            </div>
            {matched && <p className="text-xs text-gray-400">Подходит: {matched.size.toLocaleString("ru-RU")}</p>}

            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Острова</p>
              <div className="space-y-0.5">
                {atlas.clusters.map((c) => (
                  <button key={c.id} onClick={() => chooseIsland(island === c.id ? null : c.id)} title={c.top.join(", ")}
                    className={cx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition",
                      island === c.id ? "bg-gray-700" : "hover:bg-gray-800", island !== null && island !== c.id && "opacity-50")}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="text-xs tabular-nums text-gray-500">{c.size}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 border-t border-gray-800 pt-3 text-[11px] leading-snug text-gray-500">
              <p>Острова — похожие по содержанию и по «похожему» зрителей AniList. Кольцо — мой тайтл, цвет — статус. Точку можно потянуть: соседи потянутся следом.</p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Собрана {new Date(atlas.builtAt * 1000).toLocaleDateString("ru-RU")}</span>
                {me?.isAdmin && (
                  <button onClick={async () => { await api("/api/map", { method: "POST" }); void qc.invalidateQueries({ queryKey: ["map"] }); }}
                    disabled={st.state === "building"} className="inline-flex items-center gap-1 text-accent-300 hover:text-accent-200 disabled:opacity-50">
                    <ArrowPathIcon className={cx("h-3.5 w-3.5", st.state === "building" && "animate-spin")} />
                    {st.state === "building" ? `${st.phase}…` : "Пересобрать"}
                  </button>
                )}
                <Link href="/graph/legacy" className="hover:text-gray-300">Старый граф</Link>
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Карточка при наведении */}
      {hover && !selected && <HoverCard node={hover.node} x={hover.x} y={hover.y} entry={myList.get(hover.node.id)} island={clusterById.get(hover.node.cluster)?.name} rec={recs.has(hover.node.id)} />}

      {/* Выбранный тайтл */}
      {selected && (
        <Selected key={selected.id} node={selected} island={clusterById.get(selected.cluster)} rec={recs.has(selected.id)}
          neighbors={neighborsOf(graphRef.current, String(selected.id)).map((k) => byKey.get(k)!).filter(Boolean)}
          onPick={pick} onClose={() => { setSelected(null); selectedRef.current = null; focusRef.current(null); }} />
      )}
    </Shell>
  );
}

/** Соседи по силе связи (продолжения и «похожее» — первыми) */
function neighborsOf(g: Graph | null, key: string): string[] {
  if (!g || !g.hasNode(key)) return [];
  return g.edges(key)
    .map((e) => ({ other: g.opposite(key, e), w: (g.getEdgeAttribute(e, "weight") as number) + (g.getEdgeAttribute(e, "kind") === 0 ? 5 : 0) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 8)
    .map((x) => x.other);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 -mb-24 -mt-4 md:-mt-6 lg:-mx-8 lg:-mb-10">
      <div className="relative h-[calc(100dvh-14rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] md:h-[calc(100dvh-4rem)] overflow-hidden" style={{ background: `radial-gradient(ellipse at center, #0b1220 0%, ${BG} 70%)` }}>{children}</div>
    </div>
  );
}

function Progress({ status, admin }: { status: AtlasStatus; admin: boolean }) {
  const qc = useQueryClient();
  const pct = status.total ? Math.round((status.done / status.total) * 100) : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      {status.state === "building" ? (
        <>
          <Spinner className="h-8 w-8" />
          <p className="text-lg font-semibold">Собираю карту аниме</p>
          <p className="text-sm text-gray-400">{status.phase}{pct !== null && ` — ${status.done.toLocaleString("ru-RU")} из ${status.total.toLocaleString("ru-RU")}`}</p>
          {pct !== null && <div className="h-1.5 w-72 overflow-hidden rounded-full bg-gray-800"><div className="h-full rounded-full bg-accent-400 transition-all" style={{ width: `${pct}%` }} /></div>}
          <p className="max-w-md text-xs text-gray-500">Первый раз — минут 5–10: тысячи тайтлов из AniList, их сходство и раскладка. Дальше карта открывается сразу и обновляется раз в неделю сама.</p>
        </>
      ) : (
        <>
          <p className="text-lg font-semibold">Карты ещё нет</p>
          {status.error && <p className="text-sm text-negative-300">{status.error}</p>}
          <p className="max-w-md text-sm text-gray-400">Она собирается сама в фоне в течение нескольких минут после запуска.</p>
          {admin && <Button onClick={async () => { await api("/api/map", { method: "POST" }); void qc.invalidateQueries({ queryKey: ["map"] }); }}>Собрать сейчас</Button>}
        </>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, dot, children }: { on: boolean; onClick: () => void; dot?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition",
      on ? "tone-accent solid" : "bg-gray-800 text-gray-300 hover:bg-gray-700")}>
      {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} />}
      {children}
    </button>
  );
}

function facts(n: AtlasNode) {
  return [n.year, label(FORMAT_LABELS, n.format), n.episodes && n.format !== "MOVIE" ? `${n.episodes} эп.` : null].filter(Boolean).join(" · ");
}

function MyLine({ entry, rec }: { entry?: ListEntry; rec: boolean }) {
  if (entry) return (
    <p className="flex items-center gap-1.5 text-xs" style={{ color: `var(--color-${STATUS_TONE[entry.status]}-300)` }}>
      <span className="h-2 w-2 rounded-full" style={{ background: `var(--color-${STATUS_TONE[entry.status]}-400)` }} />
      {LIST_LABELS[entry.status]}{entry.score ? ` · моя ${entry.score}` : ""}
    </p>
  );
  return rec ? <p className="text-xs text-special-300">Рекомендация для вас</p> : null;
}

/** Карточка при наведении: обложка, год/формат, оценка, мой статус, остров */
function HoverCard({ node, x, y, entry, island, rec }: { node: AtlasNode; x: number; y: number; entry?: ListEntry; island?: string; rec: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(t); }, []);
  const left = x > (typeof window !== "undefined" ? window.innerWidth - 640 : 800);
  return (
    <div className={cx("pointer-events-none absolute z-20 flex w-72 gap-3 rounded-xl bg-gray-900/95 p-2.5 shadow-2xl ring-1 ring-gray-700 backdrop-blur transition duration-150 ease-out",
      shown ? "opacity-100" : "translate-y-1 opacity-0")}
      style={{ left: left ? x - 300 : x + 18, top: Math.max(8, y - 60) }}>
      <div className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-gray-800">
        {node.cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc(node.cover, "thumb")} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{node.label}</p>
        <p className="text-xs text-gray-400">{facts(node)}{node.score ? <span className="ml-1.5 text-warning-300">★ {node.score.toFixed(1)}</span> : null}</p>
        <MyLine entry={entry} rec={rec} />
        {island && <p className="truncate text-[11px] text-gray-500">Остров «{island}»</p>}
      </div>
    </div>
  );
}

/** Выбранный тайтл: описание, мой список, прогноз, соседи на карте */
function Selected({ node, island, rec, neighbors, onPick, onClose }: {
  node: AtlasNode; island?: { name: string; color: string }; rec: boolean; neighbors: AtlasNode[]; onPick: (n: AtlasNode) => void; onClose: () => void;
}) {
  const { data: a } = useAnime(node.id);
  const { byId } = useList();
  const desc = a?.description?.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return (
    <div className="absolute bottom-3 right-3 top-3 z-20 flex w-96 max-w-[calc(100%-1.5rem)] animate-[slide-in_0.25s_ease-out] flex-col overflow-hidden rounded-xl bg-gray-900/95 shadow-2xl ring-1 ring-gray-700 backdrop-blur">
      <div className="relative h-28 shrink-0 overflow-hidden" style={{ background: island?.color ?? "#1f2937" }}>
        {a?.bannerImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc(a.bannerImage, "card")} alt="" className="h-full w-full object-cover opacity-70" />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-gray-900 to-transparent" />
        <button onClick={onClose} className="absolute right-2 top-2 rounded-full bg-black/50 p-1 text-gray-300 hover:text-white" aria-label="Закрыть"><XMarkIcon className="h-5 w-5" /></button>
      </div>
      <div className="-mt-12 flex gap-3 px-4">
        <div className="relative h-36 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-gray-700">
          {node.cover && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imgSrc(node.cover, "thumb")} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1 pt-12">
          <Link href={`/anime/${node.id}`} className="line-clamp-3 font-semibold leading-snug hover:text-accent-200">{node.label}</Link>
          <p className="text-xs text-gray-400">{facts(node)}{node.score ? <span className="ml-1.5 text-warning-300">★ {node.score.toFixed(1)}</span> : null}</p>
          {island && <p className="truncate text-xs" style={{ color: island.color }}>{island.name}</p>}
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <MyLine entry={byId.get(node.id)} rec={rec} />
        {a ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><ListControl media={a} compact /></div>
            <MatchBadge id={node.id} />
          </>
        ) : <Skel className="h-7 w-28 rounded-lg" />}
        <p className="text-xs text-gray-500">{node.genres.map((g) => GENRE_LABELS[g] ?? g).join(" · ")}</p>
        {desc && <p className="line-clamp-[8] whitespace-pre-line text-sm leading-relaxed text-gray-300">{desc}</p>}
        {neighbors.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Рядом на карте</p>
            <div className="grid grid-cols-4 gap-2">
              {neighbors.map((n) => (
                <button key={n.id} onClick={() => onPick(n)} title={n.label} className="group text-left">
                  <div className="aspect-[2/3] overflow-hidden rounded-md bg-gray-800 ring-1 ring-gray-700 transition group-hover:ring-accent-400">
                    {n.cover && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imgSrc(n.cover, "thumb")} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-gray-400 group-hover:text-gray-200">{n.label}</p>
                </button>
              ))}
            </div>
          </div>
        )}
        <Link href={`/anime/${node.id}`} className="inline-block text-sm font-medium text-accent-300 hover:text-accent-200">Открыть страницу →</Link>
      </div>
    </div>
  );
}
