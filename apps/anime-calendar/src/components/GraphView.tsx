"use client";
import { ArrowPathIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Graph from "graphology";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type Sigma from "sigma";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import { api } from "@/lib/client";
import { FA2_SETTINGS, layoutWeight } from "@/lib/graph-layout";
import { GENRE_LABELS, LIST_LABELS } from "@/lib/labels";
import type { GraphNode, GraphResponse } from "@/server/reco/graph";
import { Button, cx, ErrorBox, Spinner } from "./ui";
import { imgSrc } from "@/lib/img";

const EDGE_COLORS = { relation: "#9ca3af", community: "#4b5563", similar: "#3730a3" } as const;

/**
 * Подпись при наведении. Стандартная в sigma рисует белую плашку, а подписи у нас светлые —
 * текст пропадал. Здесь тёмная плашка с обводкой цветом кластера.
 */
const drawHover: NodeHoverDrawingFunction = (ctx, data, settings) => {
  const size = settings.labelSize;
  ctx.font = `600 ${size}px ${settings.labelFont}`;
  const label = data.label ?? "";
  const padX = 6;
  const h = size + 10;
  const w = label ? ctx.measureText(label).width + padX * 2 : 0;
  const x = data.x + data.size + 4;
  const y = data.y - h / 2;
  // Ореол вокруг узла
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  ctx.fillStyle = "#111827";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = data.color;
  ctx.stroke();
  if (!label) return;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fillStyle = "rgba(17, 24, 39, 0.95)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#f9fafb";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX, data.y);
  ctx.textBaseline = "alphabetic";
};

export function GraphView() {
  const qc = useQueryClient();
  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ["graph"],
    queryFn: () => api<GraphResponse>("/api/graph"),
    staleTime: 30 * 60_000,
  });
  const container = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [cluster, setCluster] = useState<number | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(0);

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [String(n.id), n])), [data]);
  const clusterColor = useMemo(() => new Map((data?.clusters ?? []).map((c) => [c.id, c.color])), [data]);

  // Граф и рендерер создаются один раз на набор данных
  useEffect(() => {
    if (!data || !container.current) return;
    let disposed = false;
    const g = new Graph({ type: "undirected" });
    const clusterOf = new Map(data.nodes.map((n) => [String(n.id), n.cluster]));
    for (const n of data.nodes) {
      g.addNode(String(n.id), {
        x: n.x, y: n.y, size: n.size, label: n.label,
        color: clusterColor.get(n.cluster) ?? "#6b7280",
        borderColor: n.kind === "mine" ? "#ffffff" : undefined,
      });
    }
    for (const e of data.edges) {
      const s = String(e.source);
      const t = String(e.target);
      if (!g.hasEdge(s, t)) g.addEdge(s, t, { size: Math.min(3, 0.4 + e.weight * 0.4), color: EDGE_COLORS[e.kind], layoutWeight: layoutWeight(e.weight, clusterOf.get(s) === clusterOf.get(t)) });
    }
    let layout: { start(): void; stop(): void; kill(): void } | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Физика как в Obsidian: раскладка работает в воркере, после встряски сама затухает
    const shake = (ms: number) => {
      if (!layout) return;
      clearTimeout(settle);
      layout.start();
      if (ms > 0) settle = setTimeout(() => layout?.stop(), ms);
    };
    void Promise.all([import("sigma"), import("graphology-layout-forceatlas2/worker"), import("graphology-layout-forceatlas2")]).then(
      ([{ default: SigmaCtor }, { default: FA2Layout }, { default: fa2 }]) => {
        if (disposed || !container.current) return;
        const renderer = new SigmaCtor(g, container.current, {
          labelColor: { color: "#e5e7eb" },
          labelFont: "Inter, sans-serif",
          labelSize: 12,
          // Подписи только у крупных узлов и не гуще сетки: иначе они налезают друг на друга
          labelRenderedSizeThreshold: 9,
          labelDensity: 0.5,
          labelGridCellSize: 120,
          defaultEdgeColor: "#374151",
          defaultDrawNodeHover: drawHover,
          zIndex: true,
        });
        layout = new FA2Layout(g, {
          getEdgeWeight: "layoutWeight",
          settings: { ...FA2_SETTINGS(fa2.inferSettings(g)), slowDown: 6 },
        });

        // Перетаскивание: узел закрепляется под курсором, остальные подтягиваются за ним
        let dragged: string | null = null;
        let moved = false;
        renderer.on("downNode", ({ node }) => {
          dragged = node;
          moved = false;
          g.setNodeAttribute(node, "fixed", true);
          if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
          shake(0);
        });
        renderer.on("moveBody", ({ event }) => {
          if (!dragged) return;
          moved = true;
          const pos = renderer.viewportToGraph(event);
          g.mergeNodeAttributes(dragged, { x: pos.x, y: pos.y });
          event.preventSigmaDefault();
          event.original.preventDefault();
          event.original.stopPropagation();
        });
        const release = () => {
          if (!dragged) return;
          g.removeNodeAttribute(dragged, "fixed");
          dragged = null;
          shake(2500); // отпущенный граф ещё пару секунд «расправляется»
        };
        renderer.on("upNode", release);
        renderer.on("upStage", release);
        renderer.on("enterNode", ({ node }) => setHovered(node));
        renderer.on("leaveNode", () => setHovered(null));
        renderer.on("clickNode", ({ node }) => {
          if (!moved) setSelected(byId.get(node) ?? null);
        });
        renderer.on("clickStage", () => setSelected(null));
        sigmaRef.current = renderer;
        setReady((n) => n + 1);
        shake(3000); // лёгкая встряска при открытии: граф «оживает»
      },
    );
    return () => {
      disposed = true;
      clearTimeout(settle);
      layout?.kill();
      sigmaRef.current?.kill();
      sigmaRef.current = null;
    };
  }, [data, byId, clusterColor]);

  // Подсветка: наведение/выбор → соседи; фокус кластера; «только моё»; поиск
  useEffect(() => {
    const r = sigmaRef.current;
    if (!r) return;
    const g = r.getGraph();
    const focus = hovered ?? (selected ? String(selected.id) : null);
    const neighbors = focus && g.hasNode(focus) ? new Set([focus, ...g.neighbors(focus)]) : null;
    const q = query.trim().toLowerCase();
    r.setSetting("nodeReducer", (node, attrs) => {
      const n = byId.get(node);
      const res = { ...attrs };
      const hidden = (onlyMine && n?.kind === "other") || (cluster !== null && n?.cluster !== cluster);
      const dim = (neighbors && !neighbors.has(node)) || (q && !n?.label.toLowerCase().includes(q));
      if (hidden) res.hidden = true;
      else if (dim) { res.color = "#1f2937"; res.label = ""; res.zIndex = 0; }
      else if (neighbors?.has(node) || (q && n?.label.toLowerCase().includes(q))) { res.highlighted = true; res.zIndex = 2; res.forceLabel = true; }
      return res;
    });
    r.setSetting("edgeReducer", (edge, attrs) => {
      const [s, t] = g.extremities(edge);
      const res = { ...attrs };
      if (neighbors && !(neighbors.has(s) && neighbors.has(t))) res.hidden = true;
      else if (neighbors) res.color = "#a5b4fc";
      return res;
    });
    r.refresh();
  }, [hovered, selected, cluster, onlyMine, query, byId, ready]);

  // Поиск: камера к первому совпадению
  const jump = () => {
    const r = sigmaRef.current;
    const q = query.trim().toLowerCase();
    const hit = data?.nodes.find((n) => n.label.toLowerCase().includes(q));
    if (!r || !hit) return;
    const pos = r.getNodeDisplayData(String(hit.id));
    if (pos) r.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.3 }, { duration: 600 });
    setSelected(hit);
  };

  const refresh = async () => {
    qc.setQueryData(["graph"], await api<GraphResponse>("/api/graph?refresh=1"));
  };

  return (
    <div className="-mx-4 -mb-24 -mt-6 lg:-mx-8 lg:-mb-10">
      <div className="relative h-[calc(100vh-4rem)] overflow-hidden bg-gray-950">
        {isLoading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-400">
            <Spinner className="h-8 w-8" /> Строю граф: профили тайтлов, связи и кластеры…
          </div>
        ) : error ? (
          <div className="p-6"><ErrorBox error={error} /></div>
        ) : (
          <div ref={container} className="absolute inset-0" />
        )}

        {/* Панель управления */}
        {data && (
          <div className="absolute left-4 top-4 w-72 space-y-3 rounded-xl bg-gray-900/90 p-4 shadow-xl ring-1 ring-gray-700 backdrop-blur">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-bold">Граф аниме</h1>
              <Button size="sm" variant="ghost" onClick={refresh} disabled={isFetching} title="Пересчитать">
                <ArrowPathIcon className={cx("h-4 w-4", isFetching && "animate-spin")} />
              </Button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); jump(); }} className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти тайтл"
                className="w-full rounded-md border border-gray-700 bg-gray-800 py-1.5 pl-8 pr-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </form>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" className="accent-indigo-500" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              Только моё и рекомендации
            </label>
            <div className="max-h-[45vh] space-y-1 overflow-y-auto pr-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Кластеры</p>
              {data.clusters.map((c) => (
                <button key={c.id} onClick={() => setCluster(cluster === c.id ? null : c.id)} title={c.top.join(", ")}
                  className={cx("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition",
                    cluster === c.id ? "bg-gray-700" : "hover:bg-gray-800", cluster !== null && cluster !== c.id && "opacity-50")}>
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-gray-500">{c.size}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-gray-500">
              Узлы можно перетаскивать — граф подтянется следом. Цвет — кластер, белая обводка — мои тайтлы. Рёбра: светлые — продолжения, серые — «похожее» от сообщества, синие — сходство по содержанию.
            </p>
          </div>
        )}

        {/* Карточка выбранного тайтла */}
        {selected && (
          <div className="absolute bottom-4 right-4 flex w-96 max-w-[calc(100%-2rem)] gap-3 rounded-xl bg-gray-900/95 p-3 shadow-2xl ring-1 ring-gray-700 backdrop-blur">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgSrc(selected.cover ?? "", "thumb")} alt="" className="h-36 w-24 shrink-0 rounded-lg object-cover" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-start gap-2">
                <p className="line-clamp-2 flex-1 font-semibold leading-snug">{selected.label}</p>
                <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-white" aria-label="Закрыть"><XMarkIcon className="h-5 w-5" /></button>
              </div>
              <p className="text-xs text-gray-400">
                {selected.kind === "mine" ? `В моих списках: ${LIST_LABELS[selected.status as keyof typeof LIST_LABELS] ?? selected.status}${selected.myScore ? ` · моя оценка ${selected.myScore}` : ""}`
                  : selected.kind === "rec" ? "Рекомендация для тебя" : "Связанный тайтл"}
              </p>
              {selected.score && <p className="text-xs text-gray-400">★ {selected.score.toFixed(1)}</p>}
              <p className="text-xs text-gray-500">{selected.genres.map((g) => GENRE_LABELS[g] ?? g).join(" · ")}</p>
              <p className="text-xs" style={{ color: clusterColor.get(selected.cluster) }}>
                {data?.clusters.find((c) => c.id === selected.cluster)?.name}
              </p>
              <Link href={`/anime/${selected.id}`} className="inline-block text-sm font-medium text-indigo-300 hover:text-indigo-200">Открыть →</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
