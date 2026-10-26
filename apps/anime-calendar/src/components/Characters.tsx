"use client";
import { MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAnime, useCharacter, useTitleCharacters } from "@/lib/client";
import { displayTitle } from "@/lib/schedule";
import type { AnimeDetails, CharacterLite, CharacterRole } from "@/lib/types";
import { Img } from "./Img";
import { TitleCard } from "./TitleCard";
import { Badge, cx, ErrorBox, Spinner } from "./ui";

// Персонажи: блок на странице тайтла, все персонажи тайтла и страница персонажа (появления в тайтлах,
// отношения и события из графа сюжета — до серии, которую зритель досмотрел).

const ROLE: Record<CharacterRole, string> = { MAIN: "главный", SUPPORTING: "второй план", BACKGROUND: "эпизод" };
const nameOf = (c: { name: string; nameRu: string | null }) => c.nameRu ?? c.name;

function Portrait({ src, className }: { src: string | null; className?: string }) {
  return src
    ? <Img src={src} size="thumb" className={cx("h-full w-full object-cover", className)} />
    : <span className="flex h-full w-full items-center justify-center text-gray-600"><UserIcon className="h-8 w-8" /></span>;
}

/** Блок «Персонажи» на странице тайтла: главные и второй план лентой, ссылка на всех. */
export function CharacterStrip({ media }: { media: AnimeDetails }) {
  const { data: chars } = useTitleCharacters(media.id);
  if (!chars?.length) return null;
  const shown = chars.filter((c) => c.role !== "BACKGROUND").slice(0, 12);
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <h2 className="mr-auto text-xl font-bold">Персонажи <span className="text-base font-normal text-gray-500">{chars.length}</span></h2>
        <Link href={`/anime/${media.id}/characters`} className="text-sm text-accent-300 hover:text-accent-200">Все персонажи</Link>
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {shown.map((c) => <CharacterTile key={c.id} c={c} />)}
      </div>
    </section>
  );
}

function CharacterTile({ c, wide }: { c: CharacterLite; wide?: boolean }) {
  return (
    <Link href={`/characters/${c.id}`} className={cx("group flex flex-col gap-1.5", wide ? "" : "w-28 shrink-0")}>
      <div className="aspect-3/4 overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700 transition group-hover:ring-accent-500">
        <Portrait src={c.image} />
      </div>
      <span className="line-clamp-2 text-sm font-medium leading-tight text-gray-200">{nameOf(c)}</span>
      <span className="text-xs text-gray-500">{ROLE[c.role]}{c.voice && wide ? ` · ${c.voice}` : ""}</span>
    </Link>
  );
}

/** Все персонажи тайтла: поиск по любому имени, группы по роли. */
export function TitleCharactersView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data: chars, error, isLoading } = useTitleCharacters(id);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (chars ?? []).filter((c) => !needle || [c.name, c.nameRu, c.native].some((n) => n?.toLowerCase().includes(needle)));
    return (["MAIN", "SUPPORTING", "BACKGROUND"] as const).map((role) => ({ role, items: list.filter((c) => c.role === role) })).filter((g) => g.items.length);
  }, [chars, q]);
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div>
        <Link href={`/anime/${id}`} className="text-sm text-gray-400 hover:text-gray-200">{anime ? displayTitle(anime.title) : "Тайтл"}</Link>
        <h1 className="mt-1 text-2xl font-bold">Персонажи {chars && <span className="text-lg font-normal text-gray-500">{chars.length}</span>}</h1>
      </div>
      <label className="flex h-11 max-w-sm items-center gap-2 rounded-lg bg-gray-800 px-3 ring-1 ring-gray-700 focus-within:ring-accent-500">
        <MagnifyingGlassIcon className="h-4 w-4 text-gray-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, в том числе по-японски" aria-label="Поиск персонажа"
          className="w-full bg-transparent text-sm outline-none placeholder:text-gray-500" />
      </label>
      {isLoading && <Spinner />}
      {groups.map((g) => (
        <section key={g.role}>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            {g.role === "MAIN" ? "Главные" : g.role === "SUPPORTING" ? "Второй план" : "Эпизодические"} <span className="text-gray-600">{g.items.length}</span>
          </h2>
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {g.items.map((c) => <CharacterTile key={c.id} c={c} wide />)}
          </div>
        </section>
      ))}
      {chars && !chars.length && <p className="text-gray-400">AniList не знает персонажей этого тайтла.</p>}
    </div>
  );
}

/** Описание AniList: «__жирный__», ссылки [текст](адрес), спойлеры ~!…!~ — скрыты до клика. */
function CharacterDescription({ text }: { text: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const clean = (s: string) => s.replace(/__(.+?)__/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/<[^>]+>/g, "");
  const parts = text.split(/(~![\s\S]*?!~)/g);
  return (
    <p className="whitespace-pre-line leading-relaxed text-gray-300">
      {parts.map((p, i) => {
        if (!p.startsWith("~!")) return <span key={i}>{clean(p)}</span>;
        const body = clean(p.slice(2, -2));
        return open.has(i)
          ? <span key={i} className="rounded bg-special-500/15">{body}</span>
          : <button key={i} onClick={() => setOpen((s) => new Set(s).add(i))} className="rounded bg-gray-700 px-1.5 text-sm text-gray-400 hover:text-gray-200">спойлер — показать</button>;
      })}
    </p>
  );
}

/** Страница персонажа. */
export function CharacterView({ id }: { id: number }) {
  const { data: c, error, isLoading } = useCharacter(id);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !c) return <Spinner />;
  const names = [c.nameRu ? c.name : null, c.native, ...c.alternative].filter((x): x is string => Boolean(x));
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 sm:p-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="aspect-3/4 w-44 shrink-0 overflow-hidden rounded-2xl bg-gray-800 ring-1 ring-gray-700 sm:w-56">
          <Portrait src={c.image} />
        </div>
        <div className="min-w-0 space-y-3">
          <h1 className="text-3xl font-bold">{nameOf(c)}</h1>
          {names.length > 0 && <p className="text-sm text-gray-400">{names.join(" · ")}</p>}
          <div className="flex flex-wrap gap-2">
            {c.gender && <Badge tone="neutral">{c.gender === "Female" ? "женский" : c.gender === "Male" ? "мужской" : c.gender}</Badge>}
            {c.age && <Badge tone="neutral">возраст: {c.age}</Badge>}
            <Badge tone="neutral">{c.appearances.length} {c.appearances.length === 1 ? "тайтл" : "тайтлов"}</Badge>
          </div>
          {c.description && <CharacterDescription text={c.description} />}
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-xl font-bold">Появления <span className="text-base font-normal text-gray-500">{c.appearances.length}</span></h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {c.appearances.map((a) => (
            <TitleCard key={a.media.id} media={a.media} footer={<p className="text-center text-xs text-gray-400">{ROLE[a.role]}</p>} />
          ))}
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-xl font-bold">Отношения</h2>
          {c.relations.length ? (
            <ul className="space-y-2">
              {c.relations.map((r, i) => (
                <li key={i}>
                  <Link href={r.otherAnilistId ? `/characters/${r.otherAnilistId}` : "#"} className="flex items-center gap-3 rounded-xl bg-gray-800/50 p-2.5 ring-1 ring-gray-700 hover:ring-gray-600">
                    <span className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-gray-800"><Portrait src={r.otherImage} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{r.otherName}</span>
                      <span className="block text-xs text-gray-400">{r.label ?? r.kind}</span>
                    </span>
                    {r.fromEp && <span className="text-xs text-gray-500">с {r.fromEp} серии</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : <PlotEmpty />}
        </section>
        <section>
          <h2 className="mb-3 text-xl font-bold">События</h2>
          {c.events.length ? (
            <ol className="space-y-3 border-l-2 border-gray-700 pl-4">
              {c.events.map((e) => (
                <li key={e.id}>
                  <p className="text-xs text-gray-500">{e.epFrom ? `серия ${e.epFrom}${e.epTo && e.epTo !== e.epFrom ? `–${e.epTo}` : ""}` : ""}</p>
                  <p className="font-medium">{e.title}</p>
                  {e.summary && <p className="text-sm text-gray-400">{e.summary}</p>}
                </li>
              ))}
            </ol>
          ) : <PlotEmpty />}
        </section>
      </div>
    </div>
  );
}

function PlotEmpty() {
  return (
    <p className="rounded-xl bg-gray-800/40 px-4 py-3 text-sm text-gray-400 ring-1 ring-gray-700">
      Появится после глубокого разбора тайтлов — и только до серии, которую вы досмотрели.
    </p>
  );
}
