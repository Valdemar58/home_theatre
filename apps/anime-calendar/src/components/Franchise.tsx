"use client";
import { ArrowRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFranchise, useTitleCast } from "@/lib/client";
import { KIND_LABELS, type FranchiseKind } from "@/lib/franchise";
import { FORMAT_LABELS, label, LIST_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import type { FranchiseView as View } from "@/lib/types";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { CharacterCard } from "./Characters";
import { Img } from "./Img";
import { Badge, Chip, cx, ErrorBox, Skel, Spinner, type Tone } from "./ui";

// Страница франшизы (IDEAS #80): все сезоны, фильмы, OVA и спин-оффы в порядке выхода с моим прогрессом, что смотреть
// дальше, арки сюжета каждого сезона на мой прогресс (без спойлеров) и состав того сезона, где я сейчас.

const KIND_TONE: Record<FranchiseKind, Tone> = { main: "accent", side: "info", spinoff: "special", recap: "neutral", alt: "warning" };

type Item = View["items"][number];

const total = (m: Item["media"]) => m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null);

/** Сколько я посмотрел: «просмотрено», «7 из 12», «запланировано». */
function entryNote(it: Item): string | null {
  const e = it.entry;
  if (!e) return null;
  if (e.status === "completed") return LIST_LABELS.completed.toLowerCase();
  const t = total(it.media);
  if (e.episodes > 0) return `${LIST_LABELS[e.status].toLowerCase()} · ${e.episodes}${t ? ` из ${t}` : ""}`;
  return LIST_LABELS[e.status].toLowerCase();
}

export function FranchiseView({ id }: { id: number }) {
  const router = useRouter();
  const { data, error, isLoading } = useFranchise(id);
  const [kind, setKind] = useState<FranchiseKind | null>(null);
  // Открыли по любому тайтлу франшизы — адрес по корню (одна страница на франшизу)
  useEffect(() => { if (data && data.root !== id) router.replace(`/franchise/${data.root}`); }, [data, id, router]);
  useRememberTitle(data?.castTitle ?? id);
  const kinds = useMemo(() => [...new Set((data?.items ?? []).map((i) => i.kind))], [data]);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <FranchiseSkeleton />;
  const root = data.items.find((i) => i.media.id === data.root)?.media;
  const name = root ? displayTitle(root.title) : "Франшиза";
  const list = data.items.filter((i) => kind === null || i.kind === kind);
  const next = data.items.find((i) => i.media.id === data.next);
  const pct = data.progress.total ? Math.round((data.progress.watched / data.progress.total) * 100) : 0;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="space-y-3">
        <Breadcrumbs items={[{ label: name, href: `/anime/${data.root}` }, { label: "Франшиза" }]} />
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="mr-auto min-w-0">
            <h1 className="text-2xl font-bold">{name}</h1>
            <p className="mt-1 text-sm text-gray-400">
              {data.items.length} {data.items.length === 1 ? "тайтл" : data.items.length < 5 ? "тайтла" : "тайтлов"} · основная история и дополнения: {data.progress.watched} из {data.progress.total} серий
            </p>
            <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-gray-800">
              <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
          {next && (
            <Link href={`/anime/${next.media.id}`} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm tone-accent soft ring-1 ring-inset">
              <span className="min-w-0"><span className="block text-xs opacity-80">Смотреть дальше</span><span className="font-semibold">{displayTitle(next.media.title)}</span></span>
              <ArrowRightIcon className="h-4 w-4 shrink-0" />
            </Link>
          )}
        </div>
        {data.partial && <p className="flex items-center gap-2 text-sm text-gray-400"><Spinner className="h-4 w-4" />Догружаем связанные тайтлы — список дополнится сам.</p>}
      </div>

      {kinds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Chip active={kind === null} onClick={() => setKind(null)}>Все</Chip>
          {kinds.map((k) => <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{KIND_LABELS[k]}</Chip>)}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-xl font-bold">Порядок просмотра <span className="text-base font-normal text-gray-500">по выходу</span></h2>
        <ol className="space-y-2">
          {list.map((it) => <Row key={it.media.id} it={it} next={it.media.id === data.next} />)}
        </ol>
      </section>

      <Cast id={data.castTitle} title={data.items.find((i) => i.media.id === data.castTitle)?.media.title} />
    </div>
  );
}

function Row({ it, next }: { it: Item; next: boolean }) {
  const m = it.media;
  const t = total(m);
  const done = it.entry?.status === "completed" ? 1 : t && it.entry ? Math.min(1, it.entry.episodes / t) : 0;
  const note = entryNote(it);
  return (
    <li className={cx("flex gap-3 rounded-xl bg-gray-800/50 p-3 ring-1", next ? "ring-accent-500/60" : "ring-gray-700")}>
      <Link href={`/anime/${m.id}`} className="relative h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-gray-800">
        {m.coverImage.large && <Img src={m.coverImage.large} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={KIND_TONE[it.kind]}>{KIND_LABELS[it.kind]}</Badge>
          {next && <Badge tone="accent" variant="solid">Дальше</Badge>}
          <span className="text-xs text-gray-400">
            {[label(FORMAT_LABELS, m.format), m.startDate.year, t ? `${t} сер.` : null, m.status === "RELEASING" ? "выходит" : m.status === "NOT_YET_RELEASED" ? "анонс" : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <Link href={`/anime/${m.id}`} className="block font-semibold leading-snug hover:text-accent-200">{displayTitle(m.title)}</Link>
        {note && (
          <div className="flex items-center gap-2">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-gray-700"><div className="h-full rounded-full bg-positive-500" style={{ width: `${Math.round(done * 100)}%` }} /></div>
            <span className="text-xs text-gray-400">{note}</span>
          </div>
        )}
        {it.plot && <Arcs id={m.id} plot={it.plot} />}
      </div>
    </li>
  );
}

/** Арки сезона на мой прогресс: что уже было (ссылки на события), сколько событий впереди — без названий. */
function Arcs({ id, plot }: { id: number; plot: NonNullable<Item["plot"]> }) {
  if (!plot.arcs.length && !plot.events) {
    return <p className="text-xs text-gray-500">Сюжет разобран — откроется с первой просмотренной серией. <Link href={`/anime/${id}/events`} className="text-accent-300 hover:text-accent-200">События</Link></p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-gray-500">Арки:</span>
      {plot.arcs.map((a) => (
        <Link key={a.name} href={`/anime/${id}/events`} className="rounded-full bg-gray-700/60 px-2 py-0.5 text-gray-200 hover:bg-gray-700">
          {a.name}{a.fromEp ? <span className="text-gray-400"> · с {a.fromEp} сер.</span> : null}
        </Link>
      ))}
      {plot.ahead > 0 && <span className="text-gray-500">ещё {plot.ahead} {plot.ahead % 10 === 1 && plot.ahead % 100 !== 11 ? "событие" : "событий"} впереди</span>}
    </div>
  );
}

/** Состав сезона, где я сейчас, — на мой прогресс (кого ещё не видел — нет). */
function Cast({ id, title }: { id: number; title?: Item["media"]["title"] }) {
  const { data: cast, isLoading } = useTitleCast(id);
  if (!isLoading && !cast?.members.length) return null;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="mr-auto text-xl font-bold">Персонажи {title && <span className="text-base font-normal text-gray-500">{displayTitle(title)}</span>}</h2>
        <Link href={`/anime/${id}/characters`} className="text-sm text-accent-300 hover:text-accent-200">Все персонажи</Link>
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2 pt-1">
        {cast ? cast.members.slice(0, 12).map((m) => <div key={m.href} className="w-32 shrink-0"><CharacterCard m={m} anilistId={id} /></div>)
          : Array.from({ length: 8 }, (_, i) => <Skel key={i} className="aspect-2/3 w-32 shrink-0 rounded-xl" />)}
      </div>
    </section>
  );
}

function FranchiseSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" aria-busy>
      <div className="space-y-2"><Skel className="h-4 w-48" /><Skel className="h-8 w-80" /><Skel className="h-4 w-64" /></div>
      <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skel key={i} className="h-30 w-full rounded-xl" />)}</div>
    </div>
  );
}
