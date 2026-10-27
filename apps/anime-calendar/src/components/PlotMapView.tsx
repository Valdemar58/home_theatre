"use client";
import { ArrowsPointingInIcon, MinusIcon, PlusIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnime, usePlotMap } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { FOG_RADIUS, placeLabels } from "@/lib/plot-map";
import { displayTitle } from "@/lib/schedule";
import type { PlotMap } from "@/lib/types";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { EpisodePicker } from "./Characters";
import { eventHref } from "./Events";
import { Img } from "./Img";
import { cx, ErrorBox, Skel } from "./ui";

// Карта мест тайтла: официальная карта мира с вики, места графа точками, туман над тем, чего зритель ещё не видел
// (подписи будущих мест закрыты), пути персонажей по местам событий, ползунок серии (не дальше «Сюжета на серию»).

export function PlotMapView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data, error, isLoading } = usePlotMap(id);
  useRememberTitle(id);
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Breadcrumbs items={[{ label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Карта мест" }]} />
          <h1 className="mt-1 text-2xl font-bold">Карта мест {data && <span className="text-lg font-normal text-gray-500">{data.places.length}</span>}</h1>
        </div>
        {data ? <EpisodePicker anilistId={id} cursor={data.cursor} /> : <Skel className="h-9 w-44 rounded-full" />}
      </div>
      {isLoading && (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-2"><Skel className="h-8 w-56 rounded-full" /><Skel className="aspect-[4/3] w-full rounded-2xl" /></div>
          <Skel className="h-72 w-full rounded-2xl" />
        </div>
      )}
      {data && !data.map && <p className="text-gray-400">Карты для этого тайтла пока нет: её строят после разбора серий, если на вики тайтла есть карта мира.</p>}
      {data?.map && <Scene id={id} data={data} />}
    </div>
  );
}

const ALL = 1e6;

function Scene({ id, data }: { id: number; data: PlotMap }) {
  const map = data.map!;
  const ratio = map.crop.h / map.crop.w;
  const H = 1000 * ratio;
  const last = Math.max(1, ...data.places.filter((p) => p.anilistId === id).map((p) => p.firstEp), ...data.events.filter((e) => e.anilistId === id).map((e) => e.ep));
  const top = data.cursor.ep >= ALL ? last : Math.min(data.cursor.ep, last);
  const [at, setAt] = useState(top);
  useEffect(() => setAt(top), [top]);
  const [layers, setLayers] = useState({ paths: true, events: true, fog: true });
  const [person, setPerson] = useState<number | null>(data.people[0]?.id ?? null);
  const [selected, setSelected] = useState<number | null>(null);
  // Пришли со страницы места («Показать на карте») — оно сразу выбрано
  useEffect(() => { const p = Number(new URLSearchParams(window.location.search).get("place")); if (p) setSelected(p); }, []);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Ползунок — по сериям этого тайтла; предыстории видны целиком
  const upTo = (anilistId: number, ep: number) => anilistId !== id || ep <= at;
  const places = useMemo(() => data.places.filter((p) => upTo(p.anilistId, p.firstEp)), [data.places, at]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);
  const events = useMemo(() => data.events.filter((e) => upTo(e.anilistId, e.ep) && byId.has(e.placeId)), [data.events, byId, at]); // eslint-disable-line react-hooks/exhaustive-deps
  const eventsAt = useMemo(() => {
    const m = new Map<number, PlotMap["events"]>();
    for (const e of events) m.set(e.placeId, [...(m.get(e.placeId) ?? []), e]);
    return m;
  }, [events]);
  const stops = (p: PlotMap["people"][number]) => p.stops.filter((s) => upTo(s.anilistId, s.ep) && byId.has(s.placeId));
  const path = data.people.find((p) => p.id === person);
  const pathStops = path ? stops(path) : [];
  // Кто где на серию ползунка: последнее место из его событий
  const whereNow = data.people.map((p) => ({ p, s: stops(p).at(-1) })).filter((x) => x.s).slice(0, 12);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height;
      setView((v) => {
        const k = Math.min(6, Math.max(1, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Ширина карты на экране — чтобы подписи мест не наезжали (на масштабе сравниваем их прямоугольники)
  const [boxW, setBoxW] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const KIND_RANK: Record<string, number> = { "континент": 6, "страна": 5, "лес": 4, "горы": 3, "водоём": 3, "город": 3, "деревня": 2, "пещера": 2 };
  const labelled = useMemo(() => {
    const W = boxW * view.k, Hpx = boxW * ratio * view.k;
    return placeLabels(places.map((p) => {
      const w = Math.min(144, p.name.length * 6.2 + 16) / W, h = 18 / Hpx;
      return { id: p.id, x: p.x - w / 2, y: p.y + 9 / Hpx, w, h, priority: (p.id === selected ? 1000 : 0) + (eventsAt.get(p.id)?.length ?? 0) * 2 + (KIND_RANK[p.kind] ?? 1) };
    }));
  }, [places, boxW, ratio, view.k, selected, eventsAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = selected !== null ? byId.get(selected) ?? null : null;
  const selEvents = sel ? eventsAt.get(sel.id) ?? [] : [];
  const visitors = sel ? data.people.filter((p) => stops(p).some((s) => s.placeId === sel.id)) : [];
  const fog = (k: string) => (FOG_RADIUS[k] ?? 0.05) * 1000;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {([["paths", "Пути"], ["events", "События"], ["fog", "Туман"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))} aria-pressed={layers[k]}
              className={cx("rounded-full px-3 py-1 text-sm ring-1 ring-inset", layers[k] ? "tone-accent soft" : "bg-gray-800 text-gray-400 ring-gray-700")}>{label}</button>
          ))}
          <div className="ml-auto flex gap-1">
            <button aria-label="Крупнее" onClick={() => setView((v) => ({ ...v, k: Math.min(6, v.k * 1.25) }))} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><PlusIcon className="h-4 w-4" /></button>
            <button aria-label="Мельче" onClick={() => setView((v) => ({ ...v, k: Math.max(1, v.k / 1.25) }))} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><MinusIcon className="h-4 w-4" /></button>
            <button aria-label="Вся карта" onClick={() => setView({ k: 1, x: 0, y: 0 })} className="rounded-lg bg-gray-800 p-2 ring-1 ring-gray-700 hover:bg-gray-700"><ArrowsPointingInIcon className="h-4 w-4" /></button>
          </div>
        </div>
        <div ref={box} style={{ aspectRatio: `${map.crop.w} / ${map.crop.h}` }}
          className="relative w-full cursor-grab touch-none overflow-hidden rounded-2xl bg-gray-950 ring-1 ring-gray-800 active:cursor-grabbing"
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
            {/* Подложка: исходная картинка, сдвинутая так, что видна только вырезанная карта (без легенды) */}
            <img src={imgSrc(map.url)} alt="" draggable={false} className="pointer-events-none absolute max-w-none select-none"
              style={{ width: `${(map.width / map.crop.w) * 100}%`, left: `${(-map.crop.x / map.crop.w) * 100}%`, top: `${(-map.crop.y / map.crop.h) * 100}%` }} />
            <svg viewBox={`0 0 1000 ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
              <defs>
                <filter id="soft"><feGaussianBlur stdDeviation="14" /></filter>
                <filter id="smudge"><feGaussianBlur stdDeviation="3" /></filter>
                <mask id="fog-mask">
                  <rect width="1000" height={H} fill="white" />
                  <g filter="url(#soft)">{places.map((p) => <circle key={p.id} cx={p.x * 1000} cy={p.y * H} r={fog(p.kind)} fill="black" />)}</g>
                </mask>
              </defs>
              {/* Подписи мест, которых зритель ещё не знает, закрыты всегда (даже без тумана) */}
              <g filter="url(#smudge)">
                {data.masks.map((m, i) => <rect key={i} x={m.x * 1000 - 4} y={m.y * H - 3} width={m.w * 1000 + 8} height={m.h * H + 6} rx="6" fill="#3a3324" opacity="0.94" />)}
              </g>
              {layers.fog && <rect width="1000" height={H} fill="#05070d" opacity="0.8" mask="url(#fog-mask)" />}
              {layers.paths && pathStops.length > 1 && (
                <g>
                  <polyline points={pathStops.map((s) => { const p = byId.get(s.placeId)!; return `${p.x * 1000},${p.y * H}`; }).join(" ")}
                    fill="none" stroke="#c4b5fd" strokeWidth="3.5" strokeDasharray="2 9" strokeLinecap="round" strokeLinejoin="round" />
                  {pathStops.map((s, i) => {
                    const p = byId.get(s.placeId)!;
                    return <text key={i} x={p.x * 1000 + 10} y={p.y * H - 12 - (i % 2) * 14} className="fill-violet-200 text-[13px] font-semibold" style={{ paintOrder: "stroke", stroke: "#05070d", strokeWidth: 4 }}>с. {s.ep}</text>;
                  })}
                </g>
              )}
            </svg>
            {places.map((p) => {
              const n = eventsAt.get(p.id)?.length ?? 0;
              return (
                <button key={p.id} onClick={() => { if (!drag.current?.moved) setSelected(p.id); }}
                  className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                  <span className={cx("block h-3.5 w-3.5 rounded-full ring-2", p.approx ? "bg-transparent ring-violet-300 [outline:2px_dashed_rgba(196,181,253,0.6)] outline-offset-2" : "bg-indigo-400 ring-indigo-100", selected === p.id && "ring-4")} />
                  {/* Подпись, которая наехала бы на более важную, скрыта — видна при наведении и приближении */}
                  <span title={p.name} className={cx("max-w-36 truncate rounded bg-gray-950/75 px-1.5 text-[11px] font-medium leading-snug text-gray-100", !labelled.has(p.id) && "pointer-events-none opacity-0")}>
                    {p.name}{layers.events && n > 0 && <span className="ml-1 text-rose-300">· {n}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-gray-900/60 px-3 py-2 ring-1 ring-gray-800">
          <span className="text-xs text-gray-400">серия</span>
          <input type="range" min={1} max={top} value={Math.min(at, top)} onChange={(e) => setAt(Number(e.target.value))} aria-label="Серия на карте" className="flex-1 accent-indigo-400" />
          <span className="w-14 text-right text-sm font-semibold text-indigo-200">{at} / {top}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-indigo-400" />место по подписи на карте</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full ring-2 ring-violet-300" />примерно: внутри места, подписи нет</span>
          <span>туман — где вы ещё не были; закрытые подписи — места после вашей серии{data.hidden > 0 ? ` (${data.hidden})` : ""}</span>
        </div>
      </div>

      <aside className="space-y-4 rounded-2xl bg-gray-900/60 p-4 ring-1 ring-gray-800">
        {sel ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Link href={`/anime/${id}/places/${sel.id}`} className="font-semibold hover:text-accent-200">{sel.name}</Link>
                <p className="text-xs text-gray-400">{[sel.kind, sel.inside ? `в «${sel.inside}»` : null, `с ${sel.firstEp} серии`].filter(Boolean).join(" · ")}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-xs text-gray-400 hover:text-gray-200">закрыть</button>
            </div>
            {selEvents.length > 0 ? (
              <ul className="space-y-1.5">
                {selEvents.map((e, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-gray-500">с. {e.ep} · </span>
                    {e.key ? <Link href={eventHref({ key: e.key, anilistId: e.anilistId })} className="hover:text-accent-200">{e.title}</Link> : e.title}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-gray-500">Событий здесь пока нет.</p>}
            {visitors.length > 0 && <p className="text-xs text-gray-400">Бывали: {visitors.map((v) => v.name).join(", ")}</p>}
          </div>
        ) : <p className="text-sm text-gray-400">Нажмите на место — события и кто там бывал.</p>}

        {data.people.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Путь</p>
            <div className="flex flex-wrap gap-1.5">
              {data.people.slice(0, 10).map((p) => (
                <button key={p.id} onClick={() => setPerson(person === p.id ? null : p.id)} aria-pressed={person === p.id}
                  className={cx("flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs ring-1 ring-inset", person === p.id ? "tone-special soft" : "bg-gray-800 text-gray-300 ring-gray-700")}>
                  <span className="relative block h-6 w-6 overflow-hidden rounded-full bg-gray-700">
                    {p.image ? <Img src={p.image} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-3.5 w-3.5 text-gray-500" />}
                  </span>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {whereNow.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Кто где на {at} серию</p>
            {whereNow.map(({ p, s }) => (
              <p key={p.id} className="flex gap-2 text-sm">
                <Link href={p.href} className="min-w-0 flex-1 truncate hover:text-accent-200">{p.name}</Link>
                <button onClick={() => setSelected(s!.placeId)} className="shrink-0 truncate text-gray-400 hover:text-gray-200">{byId.get(s!.placeId)?.name}</button>
              </p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
