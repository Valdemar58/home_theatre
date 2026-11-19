"use client";
import { MapPinIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAnime, usePlace, useTitlePlaces } from "@/lib/client";
import { displayTitle } from "@/lib/schedule";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { EpisodePicker } from "./Characters";
import { EVENT_TONE, eventHref } from "./Events";
import { Img } from "./Img";
import { Badge, Chip, ErrorBox, Skel, SkelText } from "./ui";

// Места тайтла: список (по виду, с родителем и числом событий) и страница места — названия по сериям,
// во что вложено, что внутри и рядом, события здесь и кто бывал. Всё — на «Сюжет на серию N».

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
};

const placeHref = (id: number, placeId: number) => `/anime/${id}/places/${placeId}`;

export function PlacesView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data, error, isLoading } = useTitlePlaces(id);
  useRememberTitle(id);
  const [kind, setKind] = useState<string | null>(null);
  const kinds = useMemo(() => [...new Set((data?.places ?? []).map((p) => p.kind))], [data]);
  if (error) return <ErrorBox error={error} />;
  const list = (data?.places ?? []).filter((p) => kind === null || p.kind === kind);
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Breadcrumbs items={[{ label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Места" }]} />
          <h1 className="mt-1 text-2xl font-bold">Места {data && <span className="text-lg font-normal text-gray-500">{data.places.length}</span>}</h1>
        </div>
        {data?.map && <Link href={`/anime/${id}/map`} className="flex items-center gap-1.5 text-sm text-accent-300 hover:text-accent-200"><MapPinIcon className="h-4 w-4" />На карте</Link>}
        {data ? <EpisodePicker anilistId={id} cursor={data.cursor} /> : <Skel className="h-9 w-44 rounded-full" />}
      </div>
      {kinds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <Chip active={kind === null} onClick={() => setKind(null)}>Все</Chip>
          {kinds.map((k) => <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)}>{k}</Chip>)}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading && Array.from({ length: 9 }, (_, i) => <Skel key={i} className="h-28 w-full rounded-xl" />)}
        {list.map((p) => (
          <Link key={p.id} href={placeHref(id, p.id)} className="flex flex-col gap-1.5 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700 transition hover:ring-gray-500">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-gray-500">{p.kind}</span>
              {p.events > 0 && <span className="ml-auto text-xs text-gray-400">{plural(p.events, "событие", "события", "событий")}</span>}
            </div>
            <span className="font-semibold leading-snug">{p.name}</span>
            <span className="text-xs text-gray-400">{[p.inside ? `в «${p.inside}»` : null, `с ${p.firstEp} серии`].filter(Boolean).join(" · ")}</span>
            {p.description && <span className="line-clamp-2 text-sm text-gray-400">{p.description}</span>}
          </Link>
        ))}
      </div>
      {data && !data.places.length && <p className="text-gray-400">Мест на эту серию пока нет.</p>}
      {data && data.hidden > 0 && <p className="text-sm text-gray-500">Ещё {plural(data.hidden, "место появится", "места появятся", "мест появятся")} после {data.cursor.ep} серии.</p>}
    </div>
  );
}

export function PlaceView({ id, placeId }: { id: number; placeId: number }) {
  const { data: anime } = useAnime(id);
  const { data: p, error, isLoading } = usePlace(id, placeId);
  useRememberTitle(id);
  if (error) return <ErrorBox error={error} />;
  const crumbs = [
    { label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Места", href: `/anime/${id}/places` },
    ...(p?.path ?? []).map((x) => ({ label: x.name, href: placeHref(id, x.id) })),
    { label: p?.name || "Место" },
  ];
  const head = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="mr-auto min-w-0"><Breadcrumbs items={crumbs} /></div>
      {p ? <EpisodePicker anilistId={id} cursor={p.cursor} /> : <Skel className="h-9 w-44 rounded-full" />}
    </div>
  );
  if (isLoading || !p) return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6" aria-busy>
      {head}
      <div className="space-y-2"><Skel className="h-9 w-72" /><Skel className="h-4 w-48" /></div>
      <SkelText lines={3} className="max-w-2xl" />
      <div className="grid gap-6 md:grid-cols-2"><Skel className="h-48 w-full rounded-xl" /><Skel className="h-48 w-full rounded-xl" /></div>
    </div>
  );
  if (p.hiddenUntil !== null) return (
    <div className="mx-auto max-w-xl space-y-3 p-6 text-center">
      {head}
      <p className="text-lg font-semibold">Это место появится позже</p>
      <p className="text-gray-400">Оно появится в {p.hiddenUntil} серии — вы на {p.cursor.ep}.</p>
    </div>
  );
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-6">
      {head}
      <div className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">{p.name}</h1>
          <p className="text-sm text-gray-400">{[p.kind, p.path.length ? `в «${p.path.at(-1)!.name}»` : null, `впервые в ${p.firstEp} серии`, p.nameEn].filter(Boolean).join(" · ")}</p>
        </div>
        {p.description && <p className="max-w-3xl leading-relaxed text-gray-200">{p.description}</p>}
        {p.onMap && <Link href={`/anime/${id}/map?place=${p.id}`} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm tone-accent soft"><MapPinIcon className="h-4 w-4" />Показать на карте</Link>}
      </div>

      {(p.names.length > 1 || p.futureNames > 0) && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Названия</h2>
          <div className="flex flex-wrap items-center gap-2">
            {p.names.map((n) => <span key={n.name + n.fromEp} className="rounded-full bg-gray-800 px-3 py-1 text-sm ring-1 ring-gray-700">{n.name}<span className="text-gray-500"> · с {n.fromEp}</span></span>)}
            {p.futureNames > 0 && <span className="text-sm text-special-300">ещё {p.futureNames} — позже</span>}
          </div>
        </section>
      )}

      <div className="grid gap-8 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-xl font-bold">События здесь <span className="text-base font-normal text-gray-500">{p.events.length}</span></h2>
          {p.events.length ? (
            <ol className="space-y-3 border-l-2 border-gray-800 pl-4">
              {[...p.events].reverse().map((e, i) => (
                <li key={i} className="space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-gray-500">с. {e.ep}{e.kind && <Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind}</Badge>}</p>
                  {e.key ? <Link href={eventHref({ key: e.key, anilistId: id })} className="font-medium hover:text-accent-200">{e.title}</Link> : <p className="font-medium">{e.title}</p>}
                  {e.summary && <p className="text-sm text-gray-400">{e.summary}</p>}
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-gray-500">Событий здесь на эту серию нет.</p>}
        </section>

        <div className="space-y-8">
          {p.people.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xl font-bold">Кто здесь бывал</h2>
              <div className="flex flex-wrap gap-2">
                {p.people.map((x) => (
                  <Link key={x.id} href={x.href} className="flex items-center gap-2 rounded-full bg-gray-800/60 py-1 pl-1 pr-3 text-sm ring-1 ring-gray-700 hover:ring-gray-500">
                    <span className="relative block h-7 w-7 overflow-hidden rounded-full bg-gray-700">
                      {x.image ? <Img src={x.image} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="absolute inset-0 m-auto h-4 w-4 text-gray-500" />}
                    </span>
                    {x.name}<span className="text-xs text-gray-500">с {x.firstEp}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {(p.children.length > 0 || p.links.length > 0) && (
            <section className="space-y-3">
              <h2 className="text-xl font-bold">Внутри и рядом</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {p.children.map((c) => (
                  <Link key={`c${c.id}`} href={placeHref(id, c.id)} className="rounded-xl bg-gray-800/50 px-3 py-2 ring-1 ring-gray-700 hover:ring-gray-500">
                    <span className="block text-[11px] text-gray-500">внутри · {c.kind}</span>
                    <span className="font-medium">{c.name}</span>
                  </Link>
                ))}
                {p.links.map((l, i) => (
                  <Link key={`l${i}`} href={placeHref(id, l.id)} className="rounded-xl bg-gray-800/50 px-3 py-2 ring-1 ring-gray-700 hover:ring-gray-500">
                    <span className="block text-[11px] text-gray-500">{l.kind.replace(/ от$/, "").replace(/ с$/, "")}</span>
                    <span className="font-medium">{l.name}</span>
                    {l.distance && <span className="block text-xs text-gray-400">{l.distance}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
