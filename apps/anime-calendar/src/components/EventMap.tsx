"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnime, useTitleEvents } from "@/lib/client";
import { chainLayout, laneLayout } from "@/lib/event-layout";
import { displayTitle } from "@/lib/schedule";
import type { EventBrief, TitleEvents } from "@/lib/types";
import { EpisodePicker } from "./Characters";
import { EVENT_TONE, EventCard, eventHref } from "./Events";
import { Badge, cx, ErrorBox, Segmented, Spinner, TONE_CLASS } from "./ui";

// Карта событий тайтла: «Дорожки» (сюжетные линии по сериям, стрелки причин), «Цепочка» (что привело к событию
// и к чему оно привело), «Арки» (по аркам карточками). Всё — на «Сюжет на серию N»: дальше — только число скрытого.

type Mode = "lanes" | "chain" | "arcs";
const MODE_KEY = "event-map-mode";

export function EventMapView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data, error, isLoading } = useTitleEvents(id);
  const [mode, setModeState] = useState<Mode>("lanes");
  useEffect(() => {
    try { const m = localStorage.getItem(MODE_KEY) as Mode | null; if (m) setModeState(m); } catch { /* без хранилища — по умолчанию */ }
  }, []);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* без хранилища — по умолчанию */ } };
  const [selected, setSelected] = useState<string | null>(null);
  const events = useMemo(() => data?.arcs.flatMap((a) => a.events) ?? [], [data]);
  if (error) return <ErrorBox error={error} />;
  const sel = events.find((e) => e.key === selected) ?? null;
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Link href={`/anime/${id}`} className="text-sm text-gray-400 hover:text-gray-200">{anime ? displayTitle(anime.title) : "Тайтл"}</Link>
          <h1 className="mt-1 text-2xl font-bold">Карта событий {data && <span className="text-lg font-normal text-gray-500">{events.length}</span>}</h1>
        </div>
        <Segmented value={mode} onChange={setMode} options={[["lanes", "Дорожки"], ["chain", "Цепочка"], ["arcs", "Арки"]]} />
        {data && <EpisodePicker anilistId={id} cursor={data.cursor} />}
      </div>
      {isLoading && <Spinner />}
      {data && !events.length && <p className="text-gray-400">На эту серию событий пока нет.</p>}
      {data && events.length > 0 && mode === "lanes" && <Lanes data={data} events={events} selected={selected} onSelect={setSelected} />}
      {data && events.length > 0 && mode === "chain" && <Chain events={events} center={selected ?? [...events].reverse().find((e) => e.major)?.key ?? events.at(-1)!.key} onSelect={setSelected} />}
      {data && events.length > 0 && mode === "arcs" && <Arcs data={data} />}
      {sel && mode === "lanes" && <div className="max-w-2xl"><EventCard e={sel} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- дорожки

const W = 56;
const ROW = 30;
const LABEL = 128;

function Lanes({ data, events, selected, onSelect }: { data: TitleEvents; events: EventBrief[]; selected: string | null; onSelect: (k: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const { lanes, items } = useMemo(() => laneLayout(events), [events]);
  const k = Math.min(data.cursor.ep, data.cursor.total ?? data.cursor.ep);
  const total = Math.max(data.cursor.total ?? 0, ...items.map((i) => i.end), k);
  const arcs = useMemo(() => data.arcs.filter((a) => a.name).map((a) => ({
    name: a.name!, from: Math.min(...a.events.map((e) => e.epFrom ?? 1)), to: Math.max(...a.events.map((e) => e.epTo ?? e.epFrom ?? 1)),
  })), [data.arcs]);
  const laneTop: number[] = [];
  let y = ROW + 8;
  for (const l of lanes) { laneTop.push(y); y += l.rows * ROW + 10; }
  const height = y;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const ev = new Map(events.map((e) => [e.key, e]));
  const x = (ep: number) => (ep - 1) * W;
  const lit = hover ?? selected;
  const links = events.flatMap((e) => e.causes.filter((c) => byKey.has(c.key)).map((c) => ({ from: c.key, to: e.key, kind: c.kind })));
  return (
    <div className="overflow-x-auto rounded-2xl bg-gray-950 ring-1 ring-gray-800">
      <div className="relative" style={{ width: LABEL + total * W + 24, height: height + 28 }}>
        {/* Подписи дорожек */}
        <div className="absolute left-0 top-0 z-10 h-full bg-gray-950/95" style={{ width: LABEL }}>
          <span className="absolute left-3 text-[11px] uppercase tracking-wider text-gray-500" style={{ top: 10 }}>Арки</span>
          {lanes.map((l, i) => <span key={i} className="absolute left-3 right-2 truncate text-sm text-gray-300" style={{ top: laneTop[i] + 5 }}>{l.name}</span>)}
        </div>
        <div className="absolute top-0" style={{ left: LABEL, width: total * W, height }}>
          {/* Сетка серий и будущее после курсора */}
          {Array.from({ length: total }, (_, i) => <div key={i} className="absolute top-0 h-full border-l border-gray-900" style={{ left: x(i + 1) }} />)}
          {k < total && (
            <div className="absolute top-0 flex h-full items-center justify-center bg-[repeating-linear-gradient(135deg,transparent_0_8px,rgb(255_255_255/0.03)_8px_16px)]" style={{ left: x(k + 1), width: (total - k) * W }}>
              <span className="rounded-md bg-gray-900/90 px-2 py-1 text-xs text-gray-500">скрыто · после {k} серии</span>
            </div>
          )}
          {/* Арки */}
          {arcs.map((a, i) => (
            <div key={i} title={a.name} className="absolute truncate rounded-md bg-gray-800 px-2 text-xs leading-6 text-gray-300" style={{ top: 6, left: x(a.from) + 2, width: (a.to - a.from + 1) * W - 4 }}>{a.name}</div>
          ))}
          {/* Стрелки причин */}
          <svg className="pointer-events-none absolute inset-0" width={total * W} height={height} aria-hidden>
            {links.map((l, i) => {
              const a = byKey.get(l.from)!, b = byKey.get(l.to)!;
              const x1 = x(a.end) + W - 4, y1 = laneTop[a.lane] + a.row * ROW + 12;
              const x2 = x(b.from) + 2, y2 = laneTop[b.lane] + b.row * ROW + 12;
              const on = lit !== null && (l.from === lit || l.to === lit);
              const mid = Math.max(24, (x2 - x1) / 2);
              return <path key={i} d={`M${x1} ${y1} C${x1 + mid} ${y1} ${x2 - mid} ${y2} ${x2} ${y2}`} fill="none"
                className={on ? "stroke-accent-300" : "stroke-gray-600"} strokeWidth={on ? 2 : 1} opacity={lit === null ? 0.45 : on ? 1 : 0.12} />;
            })}
          </svg>
          {/* События */}
          {items.map((it) => {
            const e = ev.get(it.key)!;
            const tone = EVENT_TONE[e.kind ?? ""] ?? "neutral";
            return (
              <button key={it.key} onClick={() => onSelect(it.key)} onPointerEnter={() => setHover(it.key)} onPointerLeave={() => setHover(null)} title={e.title}
                className={cx("absolute truncate rounded-full px-2 text-left text-xs leading-6 ring-1 soft", TONE_CLASS[tone], selected === it.key && "ring-2 ring-white/70", e.major && "font-semibold")}
                style={{ top: laneTop[it.lane] + it.row * ROW, left: x(it.from) + 2, width: (it.end - it.from + 1) * W - 4 }}>
                {e.title}
              </button>
            );
          })}
          <div className="pointer-events-none absolute top-0 h-full w-0.5 bg-special-300 shadow-[0_0_12px] shadow-special-400" style={{ left: x(k + 1) - 1 }} />
        </div>
        {/* Ось серий */}
        <div className="absolute" style={{ left: LABEL, top: height + 4 }}>
          {Array.from({ length: total }, (_, i) => i + 1).filter((n) => n === 1 || n % 5 === 0 || n === total || n === k).map((n) => (
            <span key={n} className={cx("absolute -translate-x-1/2 text-[11px]", n === k ? "font-semibold text-special-300" : "text-gray-500")} style={{ left: x(n) + W / 2 }}>{n === k ? `${n} · вы здесь` : n}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- цепочка

const CW = 240;
const CH = 92;

function Chain({ events, center, onSelect }: { events: EventBrief[]; center: string; onSelect: (k: string) => void }) {
  const cells = useMemo(() => chainLayout(events, center), [events, center]);
  const scroller = useRef<HTMLDivElement>(null);
  const ev = new Map(events.map((e) => [e.key, e]));
  const minCol = Math.min(...cells.map((c) => c.col));
  const maxCol = Math.max(...cells.map((c) => c.col));
  const rows = Math.max(...cells.map((c) => c.row)) + 1;
  const pos = new Map(cells.map((c) => [c.key, { x: (c.col - minCol) * (CW + 56), y: c.row * (CH + 16) }]));
  const width = (maxCol - minCol + 1) * (CW + 56);
  const height = rows * (CH + 16);
  const cen = ev.get(center)!;
  // Событие в центре — в поле зрения: причины уходят влево, прокрутка — к нему
  const centerX = pos.get(center)?.x ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, centerX - el.clientWidth / 2 + CW / 2), behavior: "smooth" });
  }, [centerX]);
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">Почему случилось «{cen.title}» — причины слева, последствия справа. Нажмите на событие, чтобы поставить его в центр.</p>
      <div ref={scroller} className="overflow-x-auto rounded-2xl bg-gray-950 p-4 ring-1 ring-gray-800">
        <div className="relative" style={{ width, height }}>
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
            {cells.flatMap((c) => (ev.get(c.key)?.causes ?? []).filter((x) => pos.has(x.key)).map((x) => {
              const a = pos.get(x.key)!, b = pos.get(c.key)!;
              const x1 = a.x + CW, y1 = a.y + CH / 2, x2 = b.x, y2 = b.y + CH / 2;
              return (
                <g key={`${x.key}-${c.key}`}>
                  <path d={`M${x1} ${y1} C${x1 + 28} ${y1} ${x2 - 28} ${y2} ${x2} ${y2}`} fill="none" className="stroke-accent-400/70" strokeWidth="1.6" />
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-gray-500 text-[11px]">{x.kind}</text>
                </g>
              );
            }))}
          </svg>
          {cells.map((c) => {
            const e = ev.get(c.key)!;
            const p = pos.get(c.key)!;
            return (
              <button key={c.key} onClick={() => onSelect(c.key)}
                className={cx("absolute flex flex-col gap-1 overflow-hidden rounded-xl px-3 py-2 text-left ring-1", c.key === center ? "tone-accent soft ring-2" : "bg-gray-900 ring-gray-700 hover:ring-gray-500")}
                style={{ left: p.x, top: p.y, width: CW, height: CH }}>
                <span className="flex items-center gap-2 text-[11px] text-gray-400">{e.kind && <Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind}</Badge>}с. {e.epFrom}</span>
                <span className="line-clamp-2 text-sm font-medium leading-snug">{e.title}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="max-w-2xl"><EventCard e={cen} /></div>
      <Link href={eventHref(cen)} className="text-sm text-accent-300 hover:text-accent-200">Страница события →</Link>
    </div>
  );
}

// ---------------------------------------------------------------- арки

function Arcs({ data }: { data: TitleEvents }) {
  const [open, setOpen] = useState<number>(data.arcs.length - 1);
  return (
    <div className="space-y-2">
      {data.arcs.map((a, i) => {
        const from = Math.min(...a.events.map((e) => e.epFrom ?? 1)), to = Math.max(...a.events.map((e) => e.epTo ?? e.epFrom ?? 1));
        return (
          <div key={i} className={cx("rounded-xl ring-1", i === open ? "bg-gray-900 ring-gray-600" : "bg-gray-900/50 ring-gray-800")}>
            <button onClick={() => setOpen(i === open ? -1 : i)} className="flex w-full items-center gap-4 px-4 py-3 text-left">
              <span className="w-16 shrink-0 text-sm text-gray-500">с. {from}{to !== from ? `–${to}` : ""}</span>
              <span className="min-w-0 flex-1 font-semibold">{a.name ?? "Без арки"}</span>
              <span className="text-xs text-gray-500">{a.events.length} событий</span>
            </button>
            {i === open && <div className="grid gap-3 px-4 pb-4 md:grid-cols-2">{a.events.map((e) => <EventCard key={e.key} e={e} />)}</div>}
          </div>
        );
      })}
      {data.hidden > 0 && (
        <div className="rounded-xl border border-dashed border-gray-700 px-4 py-3 text-sm text-gray-500">Ещё {data.hidden} — откроются, когда досмотрите дальше.</div>
      )}
    </div>
  );
}
