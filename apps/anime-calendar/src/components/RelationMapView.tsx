"use client";
import { ArrowsPointingInIcon, MinusIcon, PlusIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnime, useRelationMap } from "@/lib/client";
import { graphLayout, REL_TONE, ringLayout, type Pos, type Ring } from "@/lib/relation-layout";
import { displayTitle } from "@/lib/schedule";
import type { RelationMap } from "@/lib/types";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { EpisodePicker } from "./Characters";
import { Img } from "./Img";
import { cx, ErrorBox, Segmented, Skel } from "./ui";

// Карта персонажей: два режима одной сцены — «Граф» (все связи, группы островами) и «Круги» (окружение одного
// персонажа). Узлы не перерисовываются: при смене режима или центра они переезжают на новые места.

type Mode = "graph" | "rings";
type Node = RelationMap["nodes"][number];

// Цвета — из палитры, полными именами классов (Tailwind должен их видеть)
const STROKE = { accent: "stroke-accent-400", positive: "stroke-positive-400", info: "stroke-info-400", special: "stroke-special-400", negative: "stroke-negative-400", neutral: "stroke-gray-500" } as const;
const DOT = { accent: "bg-accent-400", positive: "bg-positive-400", info: "bg-info-400", special: "bg-special-400", negative: "bg-negative-400", neutral: "bg-gray-500" } as const;
const GROUP_RING = ["ring-accent-400", "ring-positive-400", "ring-warning-400", "ring-special-400", "ring-info-400", "ring-negative-400"];
const LEGEND: [keyof typeof STROKE, string][] = [["accent", "служит, наставник"], ["positive", "семья, союз"], ["info", "дружба"], ["special", "любовь"], ["negative", "вражда, соперничество"], ["neutral", "другое"]];
const RING_LABEL = ["", "Ближний круг", "Свои и союзники", "Знакомые и враги"];
const RING_R = [0, 0.17, 0.3, 0.43];

/** Плавный переезд узлов к новым местам (~0,6 с): позиции интерполируются, рёбра едут вместе с узлами. */
function useAnimated(target: Map<number, Pos & { ring?: Ring }>) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const prev = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      const ease = 1 - (1 - k) ** 3;
      const next = new Map<number, Pos & { ring?: Ring }>();
      for (const [id, p] of target) {
        const a = prev.get(id) ?? p;
        next.set(id, { ...p, x: a.x + (p.x - a.x) * ease, y: a.y + (p.y - a.y) * ease });
      }
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = shownRef.current; };
  }, [target]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  return shown;
}

export function RelationMapView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data, error, isLoading } = useRelationMap(id);
  useRememberTitle(id);
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Breadcrumbs items={[{ label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Карта персонажей" }]} />
          <h1 className="mt-1 text-2xl font-bold">Карта персонажей</h1>
        </div>
        {data ? <EpisodePicker anilistId={id} cursor={data.cursor} /> : <Skel className="h-9 w-44 rounded-full" />}
      </div>
      {isLoading && (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-2"><Skel className="h-9 w-48 rounded-lg" /><Skel className="mx-auto aspect-square max-h-[78vh] w-full rounded-2xl" /></div>
          <Skel className="h-64 w-full rounded-2xl" />
        </div>
      )}
      {data && (data.nodes.length ? <Scene data={data} /> : <p className="text-gray-400">На эту серию персонажей пока нет.</p>)}
    </div>
  );
}

function Scene({ data }: { data: RelationMap }) {
  const [mode, setMode] = useState<Mode>("graph");
  const [focus, setFocus] = useState<number>(data.nodes.find((n) => n.role === "MAIN")?.id ?? data.nodes[0].id);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Узлы без связей в «Графе» мешают — показываем только связанных (и главных)
  const linked = useMemo(() => new Set(data.edges.flatMap((e) => [e.a, e.b])), [data.edges]);
  const nodes = useMemo(() => data.nodes.filter((n) => linked.has(n.id) || n.role === "MAIN"), [data.nodes, linked]);
  const graphPos = useMemo(() => graphLayout(nodes, data.edges), [nodes, data.edges]);
  const ringPos = useMemo(() => ringLayout(focus, nodes, data.edges), [focus, nodes, data.edges]);
  const target = useMemo(() => (mode === "graph" ? graphPos : ringPos), [mode, graphPos, ringPos]);
  const pos = useAnimated(target);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const groupIndex = useMemo(() => {
    const ids = [...new Set(nodes.map((n) => n.groups[0]?.id).filter((x): x is number => x !== undefined))];
    return new Map(ids.map((g, i) => [g, i]));
  }, [nodes]);
  const visible = (id: number) => mode === "graph" || ringPos.get(id)?.ring !== null;
  const lit = hover ?? selected;
  const touches = (e: { a: number; b: number }, id: number | null) => id !== null && (e.a === id || e.b === id);

  // Колесо — масштаб вокруг курсора (React вешает onWheel пассивным — preventDefault не сработает)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height;
      setView((v) => {
        const k = Math.min(4, Math.max(0.5, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const pick = (id: number) => {
    if (drag.current?.moved) return;
    setSelected(id);
    if (mode === "rings") setFocus(id);
  };
  const sel = selected !== null ? byId.get(selected) ?? null : null;
  const selEdges = sel ? data.edges.filter((e) => touches(e, sel.id)) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={mode} onChange={(m) => { setMode(m); if (m === "rings" && selected !== null) setFocus(selected); }} options={[["graph", "Граф"], ["rings", "Круги"]]} />
          {mode === "rings" && <span className="text-sm text-gray-400">В центре — {byId.get(focus)?.name}. Нажмите на персонажа, чтобы поставить его в центр.</span>}
          <div className="ml-auto flex gap-1">
            <button aria-label="Крупнее" onClick={() => setView((v) => ({ ...v, k: Math.min(4, v.k * 1.25) }))} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><PlusIcon className="h-4 w-4" /></button>
            <button aria-label="Мельче" onClick={() => setView((v) => ({ ...v, k: Math.max(0.5, v.k / 1.25) }))} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><MinusIcon className="h-4 w-4" /></button>
            <button aria-label="Весь граф" onClick={() => setView({ k: 1, x: 0, y: 0 })} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><ArrowsPointingInIcon className="h-4 w-4" /></button>
          </div>
        </div>
        <div ref={box}
          className="relative mx-auto aspect-square max-h-[78vh] w-full cursor-grab touch-none overflow-hidden rounded-2xl bg-gray-950 ring-1 ring-gray-800 active:cursor-grabbing"
          onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !box.current) return;
            const r = box.current.getBoundingClientRect();
            const dx = (e.clientX - d.x) / r.width, dy = (e.clientY - d.y) / r.height;
            if (Math.abs(dx) + Math.abs(dy) > 0.005) d.moved = true;
            if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
          }}
          onPointerUp={() => setTimeout(() => { drag.current = null; }, 0)}
          onPointerLeave={() => { drag.current = null; }}>
          <div className="absolute inset-0 origin-top-left" style={{ transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.k})` }}>
            <svg viewBox="0 0 1000 1000" className="absolute inset-0 h-full w-full" aria-hidden>
              {mode === "rings" && RING_R.slice(1).map((r, i) => (
                <g key={r}>
                  <circle cx="500" cy="500" r={r * 1000} fill="none" className="stroke-gray-800" strokeWidth="1.5" strokeDasharray={i === 0 ? undefined : "4 6"} />
                  <text x="500" y={500 - r * 1000 - 8} textAnchor="middle" className="fill-gray-600 text-[13px]">{RING_LABEL[i + 1]}</text>
                </g>
              ))}
              {data.edges.map((e, i) => {
                const a = pos.get(e.a), b = pos.get(e.b);
                if (!a || !b || !visible(e.a) || !visible(e.b)) return null;
                const tone = REL_TONE[e.kind] ?? "neutral";
                const on = lit === null || touches(e, lit);
                return (
                  <line key={i} x1={a.x * 1000} y1={a.y * 1000} x2={b.x * 1000} y2={b.y * 1000} className={STROKE[tone]}
                    strokeWidth={touches(e, lit) ? 3 : 1.6} strokeDasharray={e.endedEp ? "6 6" : undefined} opacity={on ? (e.endedEp ? 0.45 : 0.8) : 0.08} />
                );
              })}
            </svg>
            {nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const show = visible(n.id);
              const dim = lit !== null && lit !== n.id && !data.edges.some((e) => touches(e, lit) && touches(e, n.id));
              const g = n.groups[0] ? groupIndex.get(n.groups[0].id) : undefined;
              const big = n.role === "MAIN" || (mode === "rings" && n.id === focus);
              return (
                <button key={n.id} onClick={() => pick(n.id)} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}
                  className={cx("absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-opacity duration-500", show ? "opacity-100" : "pointer-events-none opacity-0", dim && "opacity-30")}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                  <span className={cx("relative block overflow-hidden rounded-full bg-gray-800 ring-2", big ? "h-14 w-14" : "h-10 w-10", g !== undefined ? GROUP_RING[g % GROUP_RING.length] : "ring-gray-600", selected === n.id && "ring-4")}>
                    {n.image ? <Img src={n.image} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-1/2 w-1/2 text-gray-500" />}
                  </span>
                  <span className="max-w-28 truncate rounded bg-gray-950/70 px-1 text-[11px] leading-tight text-gray-200">{n.name}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
          {LEGEND.map(([t, label]) => <span key={t} className="flex items-center gap-1.5"><span className={cx("h-1 w-4 rounded", DOT[t])} />{label}</span>)}
          <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t border-dashed border-gray-400" />было, кончилось</span>
        </div>
      </div>

      <aside className="space-y-3 rounded-2xl bg-gray-900/60 p-4 ring-1 ring-gray-800">
        {sel ? (
          <>
            <div className="flex gap-3">
              <span className="relative block aspect-2/3 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-800">
                {sel.image ? <Img src={sel.image} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-8 w-8 text-gray-500" />}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="font-semibold">{sel.name}</p>
                {sel.groups.length > 0 && <p className="text-xs text-gray-400">{sel.groups.map((g) => g.name).join(", ")}</p>}
                {sel.description && <p className="line-clamp-5 text-sm text-gray-300">{sel.description}</p>}
              </div>
            </div>
            <div className="flex gap-2">
              <Link href={sel.href} className="flex-1 rounded-lg px-3 py-2 text-center text-sm tone-accent soft">Страница</Link>
              <button onClick={() => { setMode("rings"); setFocus(sel.id); }} className="flex-1 rounded-lg bg-gray-800 px-3 py-2 text-sm ring-1 ring-gray-700 hover:bg-gray-700">В центр</button>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Связи · {selEdges.length}</p>
              <ul className="max-h-80 space-y-1 overflow-y-auto">
                {selEdges.map((e, i) => {
                  const other = byId.get(e.a === sel.id ? e.b : e.a);
                  if (!other) return null;
                  const tone = REL_TONE[e.kind] ?? "neutral";
                  return (
                    <li key={i}>
                      <button onClick={() => pick(other.id)} className={cx("flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-gray-800", e.endedEp !== null && "opacity-60")}>
                        <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[tone])} />
                        <span className="min-w-0 flex-1 truncate">{other.name}</span>
                        <span className="shrink-0 text-xs text-gray-400">{e.a === sel.id ? e.kind : `${e.kind} ←`}{e.endedEp ? ` · до с. ${e.endedEp}` : e.fromEp ? ` · с. ${e.fromEp}` : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">Нажмите на персонажа — здесь появятся его связи. Колесо мыши — масштаб, перетаскивание — сдвиг. Цвет обводки — группа.</p>
        )}
      </aside>
    </div>
  );
}
