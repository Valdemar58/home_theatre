"use client";
import { MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnime, useEvent } from "@/lib/client";
import { CORPUS_SOURCE_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import type { EventBrief, EventLinkInfo } from "@/lib/types";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { EpisodePicker } from "./Characters";
import { Img } from "./Img";
import { NamedText, useNames } from "./NamedText";
import { Badge, cx, ErrorBox, Spinner, type Tone } from "./ui";

// События сюжета: карточка (причина, повод, последствие, участники), список тайтла по аркам и страница события.
// Всё — на «Сюжет на серию N»: последствия после этой серии не показываются, только их число.

export const EVENT_TONE: Record<string, Tone> = {
  "бой": "negative", "предательство": "negative", "потеря": "warning", "встреча": "info", "решение": "accent",
  "раскрытие": "special", "союз": "positive", "победа": "positive", "другое": "neutral",
};

const eps = (from: number | null, to: number | null) => (from ? (to && to !== from ? `серии ${from}–${to}` : `серия ${from}`) : "");
export const eventHref = (e: { anilistId: number; key: string }) => `/anime/${e.anilistId}/events/${encodeURIComponent(e.key)}`;

function Avatar({ src, name, className }: { src: string | null; name: string; className?: string }) {
  return (
    <span title={name} className={cx("relative inline-block overflow-hidden rounded-full bg-gray-700 ring-2 ring-gray-900", className)}>
      {src ? <Img src={src} size="tiny" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-1/2 w-1/2 text-gray-500" />}
    </span>
  );
}

/** «+N участников»: при наведении или нажатии — список по ролям; длинный — с поиском и «и ещё N». */
function Participants({ list, shown = 4 }: { list: EventBrief["participants"]; shown?: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const by = new Map<string, EventBrief["participants"]>();
    for (const p of list.filter((x) => !needle || x.name.toLowerCase().includes(needle))) by.set(p.role ?? "участник", [...(by.get(p.role ?? "участник") ?? []), p]);
    return [...by].sort((a, b) => b[1].length - a[1].length);
  }, [list, q]);
  if (!list.length) return null;
  const rest = list.length - shown;
  return (
    <div ref={box} className="relative flex items-center gap-2" onPointerLeave={(e) => e.pointerType === "mouse" && setOpen(false)}>
      <div className="flex -space-x-2">{list.slice(0, shown).map((p) => <Avatar key={p.id} src={p.image} name={p.name} className="h-8 w-8" />)}</div>
      <button onClick={() => setOpen(!open)} onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)} className="text-xs text-accent-300 hover:text-accent-200">
        {rest > 0 ? `+${rest} ${rest === 1 ? "участник" : "участников"}` : "участники"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl bg-gray-800 p-3 shadow-2xl ring-1 ring-gray-600">
          {list.length > 8 && (
            <label className="flex h-8 items-center gap-2 rounded-lg bg-gray-900 px-2 ring-1 ring-gray-700">
              <MagnifyingGlassIcon className="h-4 w-4 text-gray-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти участника" aria-label="Поиск участника" className="w-full bg-transparent text-sm outline-none" />
            </label>
          )}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {groups.map(([role, ps]) => (
              <div key={role}>
                <p className="text-[11px] uppercase tracking-wider text-gray-500">{role} · {ps.length}</p>
                {ps.slice(0, 6).map((p) => (
                  <Link key={p.id} href={p.href} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-gray-700">
                    <Avatar src={p.image} name={p.name} className="h-6 w-6 ring-0" />{p.name}
                  </Link>
                ))}
                {ps.length > 6 && <p className="px-1 text-xs text-gray-500">и ещё {ps.length - 6}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const LinkRow = ({ label, l }: { label: string; l: EventLinkInfo | undefined }) => l ? (
  <>
    <dt className="text-gray-500">{label}</dt>
    <dd className="min-w-0"><Link href={eventHref(l)} className="text-gray-200 hover:text-accent-200">{l.title}</Link>{l.ep ? <span className="text-gray-500"> · с. {l.ep}</span> : null}</dd>
  </>
) : null;

/** Карточка события: тип, серии, арка, «почему» (причина, повод, последствие), участники. */
export function EventCard({ e }: { e: EventBrief }) {
  return (
    <div className="space-y-3 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        {e.kind && <Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind}</Badge>}
        <span>{eps(e.epFrom, e.epTo)}</span>
        {e.major && <span className="text-special-300">· важное</span>}
      </div>
      <div>
        <Link href={eventHref(e)} className="text-base font-semibold leading-snug hover:text-accent-200">{e.title}</Link>
        {e.summary && <p className="mt-1 text-sm leading-relaxed text-gray-300">{e.summary}</p>}
      </div>
      {(e.causes.length > 0 || e.consequences.length > 0) && (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 text-sm">
          <LinkRow label="Причина" l={e.causes.find((c) => c.kind !== "повод")} />
          <LinkRow label="Повод" l={e.causes.find((c) => c.kind === "повод")} />
          <LinkRow label="Последствие" l={e.consequences[0]} />
        </dl>
      )}
      <Participants list={e.participants} />
    </div>
  );
}

// ---------------------------------------------------------------- страница события

function ChainItem({ l, label }: { l: EventLinkInfo; label: string }) {
  return (
    <Link href={eventHref(l)} className="block rounded-xl bg-gray-800/50 px-4 py-3 ring-1 ring-gray-700 hover:ring-gray-500">
      <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}{l.ep ? ` · серия ${l.ep}` : ""}</p>
      <p className="font-medium">{l.title}</p>
    </Link>
  );
}

/** Страница события: что к нему привело и к чему привело, ход, участники, мотивы, источник. */
export function EventView({ id, eventKey }: { id: number; eventKey: string }) {
  const { data: anime } = useAnime(id);
  const { data: e, error, isLoading } = useEvent(id, eventKey);
  const names = useNames(e?.hiddenUntil === null ? id : 0, e?.epTo ?? e?.epFrom ?? null);
  useRememberTitle(id);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !e) return <Spinner />;
  const back = <Breadcrumbs items={[
    { label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Карта событий", href: `/anime/${id}/events` },
    ...(e.arc ? [{ label: `арка «${e.arc}»` }] : []), { label: e.hiddenUntil !== null ? "Событие" : e.title },
  ]} />;
  if (e.hiddenUntil !== null) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6 text-center">
        <div className="flex justify-center">{back}</div>
        <p className="text-lg font-semibold">Это событие случится позже</p>
        <p className="text-gray-400">Оно раскроется в {e.hiddenUntil} серии — вы на {e.cursor.ep}.</p>
        <div className="flex justify-center"><EpisodePicker anilistId={id} cursor={e.cursor} /></div>
      </div>
    );
  }
  const text = (t: string) => <NamedText text={t} anilistId={id} upTo={e.epTo ?? e.epFrom} names={names} />;
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">{back}</div>
        <EpisodePicker anilistId={id} cursor={e.cursor} />
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
          {e.kind && <Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind}</Badge>}
          <span>{eps(e.epFrom, e.epTo)}</span>
        </div>
        <h1 className="text-2xl font-bold sm:text-3xl">{e.title}</h1>
        {e.summary && <p className="text-lg leading-relaxed text-gray-300">{text(e.summary)}</p>}
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">Причины и последствия</h2>
        <div className="space-y-2">
          {e.causes.map((c) => <ChainItem key={`c${c.key}`} l={c} label={c.kind} />)}
          {e.causes.length === 0 && <p className="text-sm text-gray-500">Причин в разборе не нашлось.</p>}
          <div className="rounded-xl px-4 py-3 tone-accent soft"><p className="text-[11px] uppercase tracking-wider opacity-70">Это событие</p><p className="font-semibold">{e.title}</p></div>
          {e.consequences.map((c) => <ChainItem key={`n${c.key}`} l={c} label="последствие" />)}
        </div>
        {e.hiddenConsequences > 0 && <p className="text-sm text-special-300">Ещё {e.hiddenConsequences} — последствия после вашей {e.cursor.ep} серии скрыты.</p>}
      </section>

      {e.course && (
        <section className="space-y-2">
          <h2 className="text-xl font-bold">Ход события</h2>
          <p className="whitespace-pre-line leading-relaxed text-gray-300">{text(e.course)}</p>
        </section>
      )}

      {e.participants.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-bold">Участники <span className="text-base font-normal text-gray-500">{e.participants.length}</span></h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {e.participants.map((p) => (
              <Link key={p.id} href={p.href} className="flex items-center gap-3 rounded-xl bg-gray-800/50 p-2.5 ring-1 ring-gray-700 hover:ring-gray-500">
                <Avatar src={p.image} name={p.name} className="h-10 w-10 ring-0" />
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{p.name}</span>{p.role && <span className="block text-xs text-gray-400">{p.role}</span>}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {e.motives.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xl font-bold">Мотивы и знания</h2>
          <ul className="space-y-1.5 text-sm">
            {e.motives.map((m) => <li key={m.id}><Link href={m.href} className="font-medium text-gray-100 hover:text-accent-200">{m.name}</Link> <span className="text-gray-400">— {text(m.text)}</span></li>)}
          </ul>
        </section>
      )}

      <p className="text-xs text-gray-500">
        Источник: {e.sources.length ? e.sources.map((s) => CORPUS_SOURCE_LABELS[s] ?? s).join(", ") : "пересказы серий"} — разбор ИИ, возможны неточности.
      </p>
    </div>
  );
}
