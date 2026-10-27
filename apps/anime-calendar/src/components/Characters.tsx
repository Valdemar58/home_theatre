"use client";
import { ChevronDownIcon, MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnime, useCharacter, useList, usePlotView, useTitleCast } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import type { AnimeDetails, CastMember, CharacterDetails, GalleryImage, ListEntryWithMedia, PlotCursor, TitleCast } from "@/lib/types";
import { Breadcrumbs, useRememberedTitle, useRememberTitle, type Crumb } from "./Breadcrumbs";
import { ROLE_LABEL } from "./CharacterHover";
import { Gallery } from "./Gallery";
import { useCharacterHover } from "./HoverCard";
import { Img } from "./Img";
import { Lightbox } from "./Lightbox";
import { TitleCard } from "./TitleCard";
import { Badge, Chip, cx, ErrorBox, Skel, SkelPosters, SkelText } from "./ui";

// Персонажи: блок на странице тайтла, вкладка «Персонажи» и страница персонажа. Всё — на серию курсора
// («Сюжет на серию N»: мой прогресс, другая серия или весь сезон); что раскрыто позже — не показывается.

const ALL = 1e6;

const cursorLabel = (c: PlotCursor) =>
  c.ep >= ALL || (c.total !== null && c.ep >= c.total) ? "весь сезон" : c.ep === 0 ? "до 1-й серии" : `${c.ep} серию`;

// ---------------------------------------------------------------- выбор серии

/** «Сюжет на N серию»: мой прогресс / другая серия (после моей — спойлер) / весь сезон. Прогресс в списке не меняется. */
export function EpisodePicker({ anilistId, cursor }: { anilistId: number; cursor: PlotCursor }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const set = usePlotView(anilistId);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const total = cursor.total ?? Math.max(cursor.watched, cursor.ep < ALL ? cursor.ep : 0, 12);
  const pick = (v: Parameters<typeof set.mutate>[0]) => { set.mutate(v); setOpen(false); };
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className={cx("inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm ring-1 ring-inset", cursor.mode === "progress" ? "tone-special soft" : "tone-warning soft")}>
        Сюжет на <b>{cursorLabel(cursor)}</b>
        <ChevronDownIcon className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl bg-gray-800 p-3 shadow-2xl ring-1 ring-gray-600">
          <button onClick={() => pick({ mode: "progress" })} className={cx("block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-700", cursor.mode === "progress" && "bg-gray-700")}>
            Мой прогресс <span className="text-gray-400">· {cursor.inList ? (cursor.watched ? `${cursor.watched} серия` : "ещё не начал") : "тайтла нет в списке"}</span>
          </button>
          <div>
            <p className="px-1 pb-1.5 text-xs text-gray-400">Другая серия <span className="text-special-300">· после вашей — спойлеры</span></p>
            <div className="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto">
              {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
                <button key={n} onClick={() => pick({ mode: "ep", ep: n })}
                  className={cx("h-9 rounded-md text-sm ring-1 ring-inset",
                    cursor.mode === "ep" && cursor.ep === n ? "tone-accent solid" : n > cursor.watched ? "tone-special soft" : "bg-gray-700/60 ring-gray-600 hover:bg-gray-700")}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <button onClick={() => pick({ mode: "all" })} className={cx("block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-gray-700", cursor.mode === "all" && "bg-gray-700")}>
            Весь сезон <span className="text-special-300">· со спойлерами</span>
          </button>
          <p className="px-1 text-xs text-gray-500">Выбор запоминается для тайтла и не меняет прогресс в списке.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- карточка персонажа

/** Карточка-постер, как у аниме: роль и группа сверху, имя внизу, при наведении — полная карточка. */
export function CharacterCard({ m, anilistId, big }: { m: CastMember; anilistId: number; big?: boolean }) {
  const hover = useCharacterHover({ anilistId, entity: m.id || -(m.anilistCharId ?? 0), member: m, spoilerEp: null });
  const group = m.groups[0];
  return (
    <div className="group">
      <Link {...hover} href={m.href}
        className="relative block aspect-2/3 overflow-hidden rounded-xl bg-gray-800 shadow-lg ring-1 ring-gray-700 transition duration-300 hover:scale-[1.03] hover:ring-gray-500">
        {m.image ? <Img src={m.image} size="card" className="absolute inset-0 h-full w-full object-cover object-top" />
          : <span className="absolute inset-0 flex items-center justify-center text-gray-600"><UserIcon className="h-10 w-10" /></span>}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-2">
          <span className="shrink-0 whitespace-nowrap rounded-full bg-gray-900/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-200 ring-1 ring-gray-600">
            {ROLE_LABEL[m.role]}
          </span>
          {group && <span className="min-w-0 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold tone-accent solid">{group.name}</span>}
        </div>
        <div className="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-gray-950 via-gray-950/40 to-transparent p-3 opacity-90 transition group-hover:opacity-100">
          <p className={cx("line-clamp-2 font-semibold leading-tight text-white", big ? "text-base" : "text-sm")}>{m.name}</p>
          {(m.firstEp || m.lookLabel) && (
            <p className="mt-1 line-clamp-1 text-[11px] text-gray-300">{[m.lookLabel, m.firstEp ? `с ${m.firstEp} серии` : null].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------- блок на странице тайтла

/** Блок «Персонажи» на странице тайтла: выбор серии, главные и второй план лентой, ссылка на всех. */
export function CharacterStrip({ media }: { media: AnimeDetails }) {
  const { data: cast, isLoading } = useTitleCast(media.id);
  // Загружается — заголовок и ссылка сразу, вместо карточек — заглушки того же размера; персонажей нет — блока нет
  if (!isLoading && !cast?.members.length) return null;
  const shown = cast?.members.slice(0, 10) ?? [];
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="mr-auto text-xl font-bold">Персонажи {cast && <span className="text-base font-normal text-gray-500">{cast.members.length}</span>}</h2>
        {cast?.built && <EpisodePicker anilistId={media.id} cursor={cast.cursor} />}
        <Link href={`/anime/${media.id}/characters`} className="text-sm text-accent-300 hover:text-accent-200">Все персонажи</Link>
      </div>
      {cast && <CastNotice cast={cast} />}
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2 pt-1">
        {cast ? shown.map((m) => <div key={m.href} className="w-32 shrink-0"><CharacterCard m={m} anilistId={media.id} /></div>)
          : Array.from({ length: 8 }, (_, i) => <Skel key={i} className="aspect-2/3 w-32 shrink-0 rounded-xl" />)}
      </div>
    </section>
  );
}

/** Что сейчас показано: не в списке — герои до первой серии; без разбора — только состав AniList; кто появится позже. */
function CastNotice({ cast }: { cast: TitleCast }) {
  const text = !cast.built ? "Сюжетного разбора пока нет — показан состав AniList без подробностей."
    : !cast.cursor.inList && cast.cursor.mode === "progress" ? "Тайтла нет в вашем списке — показаны только герои, известные до 1-й серии. Выберите серию, чтобы увидеть больше."
    : cast.hidden > 0 ? `Ещё ${cast.hidden} — появятся после ${cast.cursor.ep} серии.` : null;
  return text ? <p className="mb-3 text-sm text-gray-400">{text}</p> : null;
}

// ---------------------------------------------------------------- вкладка «Персонажи»

/** Все персонажи тайтла: выбор серии, группы, поиск; главные крупно, второй план — постерами. */
export function TitleCharactersView({ id }: { id: number }) {
  const { data: anime } = useAnime(id);
  const { data: cast, error, isLoading } = useTitleCast(id);
  useRememberTitle(id);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<number | null>(null);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (cast?.members ?? []).filter((m) => (!needle || [m.name, m.native, ...m.aka].some((n) => n?.toLowerCase().includes(needle)))
      && (group === null || m.groups.some((g) => g.id === group)));
  }, [cast, q, group]);
  if (error) return <ErrorBox error={error} />;
  const main = list.filter((m) => m.role === "MAIN");
  const rest = list.filter((m) => m.role !== "MAIN");
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <Breadcrumbs items={[{ label: anime ? displayTitle(anime.title) : "Тайтл", href: `/anime/${id}` }, { label: "Персонажи" }]} />
          <h1 className="mt-1 text-2xl font-bold">Персонажи {cast && <span className="text-lg font-normal text-gray-500">{cast.members.length}</span>}</h1>
        </div>
        {cast?.built && <EpisodePicker anilistId={id} cursor={cast.cursor} />}
        {isLoading && <Skel className="h-9 w-44 rounded-full" />}
      </div>
      {isLoading && (
        <>
          <Skel className="h-9 w-full max-w-xs rounded-lg" />
          <section className="space-y-3">
            <Skel className="h-4 w-24" />
            <SkelPosters count={5} className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" />
          </section>
          <section className="space-y-3">
            <Skel className="h-4 w-28" />
            <SkelPosters count={16} className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8" />
          </section>
        </>
      )}
      {cast && <CastNotice cast={cast} />}
      {cast && cast.members.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 w-full max-w-xs items-center gap-2 rounded-lg bg-gray-800 px-3 ring-1 ring-gray-700 focus-within:ring-accent-500">
            <MagnifyingGlassIcon className="h-4 w-4 text-gray-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, в том числе по-японски" aria-label="Поиск персонажа"
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-500" />
          </label>
          {cast.groups.length > 0 && (
            <>
              <Chip active={group === null} onClick={() => setGroup(null)}>Все {cast.groupWord ?? "группы"}</Chip>
              {cast.groups.map((g) => <Chip key={g.id} active={group === g.id} onClick={() => setGroup(group === g.id ? null : g.id)}>{g.name} · {g.count}</Chip>)}
            </>
          )}
        </div>
      )}
      {main.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">Главные <span className="text-gray-600">{main.length}</span></h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {main.map((m) => <CharacterCard key={m.href} m={m} anilistId={id} big />)}
          </div>
        </section>
      )}
      {rest.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">Второй план <span className="text-gray-600">{rest.length}</span></h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {rest.map((m) => <CharacterCard key={m.href} m={m} anilistId={id} />)}
          </div>
        </section>
      )}
      {cast && !cast.members.length && <p className="text-gray-400">Персонажей на эту серию пока нет.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- страница персонажа

/** Описание AniList: «__жирный__», ссылки [текст](адрес), спойлеры ~!…!~ — скрыты до клика. */
function CharacterDescription({ text }: { text: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const clean = (s: string) => s.replace(/__(.+?)__/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/<[^>]+>/g, "");
  const parts = text.split(/(~![\s\S]*?!~)/g);
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-gray-400">
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

/** Описание AniList пишут по всему сериалу: при описании по разбору серий — свёрнуто, как спойлер. */
function AnilistDescription({ text, gated }: { text: string; gated: boolean }) {
  const [open, setOpen] = useState(!gated);
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">Описание AniList</h2>
      {open ? <CharacterDescription text={text} /> : (
        <button onClick={() => setOpen(true)} className="rounded-lg px-3 py-1.5 text-sm tone-special soft">По всему сериалу, со спойлерами — показать</button>
      )}
    </section>
  );
}

const REL_ORDER = ["семья", "служит", "наставник", "любовь", "друг", "союзник", "соперник", "враг", "другое"];
const epRange = (from: number | null, to?: number | null) => (from ? `с. ${from}${to && to !== from ? `–${to}` : ""}` : "");

/** Страница персонажа: облики (листаются), имена, появления, главные связи, последние события, способности. */
export function CharacterView({ param }: { param: string }) {
  const router = useRouter();
  const { data: c, error, isLoading } = useCharacter(param);
  const remembered = useRememberedTitle();
  const { byId: myList } = useList();
  useEffect(() => { if (c?.redirect) router.replace(c.redirect); }, [c?.redirect, router]);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !c || c.redirect) return <CharacterPageSkeleton />;
  // Путь — через тайтл, откуда пришли (если персонаж в нём есть), иначе через тот, что смотрю, иначе через первое появление
  const watching = c.appearances.find((a) => myList.get(a.media.id)?.status === "watching")?.media ?? null;
  const from = c.appearances.find((a) => a.media.id === remembered)?.media
    ?? c.appearances.find((a) => a.media.id === c.hiddenUntil?.anilistId)?.media ?? watching ?? c.appearances[0]?.media;
  // Звено тайтла раскрывается сезонами, где есть персонаж, — с моим статусом
  const options = c.appearances.map((a) => ({
    label: displayTitle(a.media.title), href: `/anime/${a.media.id}`, current: a.media.id === from?.id, note: listNote(myList.get(a.media.id)),
  }));
  const crumbs = (name: string): Crumb[] => [
    ...(from ? [{ label: displayTitle(from.title), href: `/anime/${from.id}`, options }, { label: "Персонажи", href: `/anime/${from.id}/characters` }] : []),
    { label: name },
  ];
  if (c.hiddenUntil) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6 text-center">
        <div className="flex justify-center"><Breadcrumbs items={crumbs("Персонаж")} /></div>
        <p className="text-lg font-semibold">Этот персонаж появится позже</p>
        <p className="text-gray-400">Он появится в {c.hiddenUntil.ep} серии — вы её ещё не видели.</p>
        <Link href={`/anime/${c.hiddenUntil.anilistId}/characters`} className="text-accent-300 hover:text-accent-200">К персонажам тайтла</Link>
      </div>
    );
  }
  return <CharacterPage key={c.href} c={c} crumbs={crumbs(c.nameRu ?? c.name)} watching={watching && watching.id !== from?.id ? { id: watching.id, title: displayTitle(watching.title), ep: myList.get(watching.id)?.episodes ?? 0 } : null} />;
}

/** Страница персонажа до загрузки — та же раскладка: крошки, облик слева, имя и описание, имена, появления. */
function CharacterPageSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6" aria-busy>
      <Skel className="h-4 w-72" />
      <div className="space-y-8">
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="w-full shrink-0 space-y-2 md:w-80">
            <Skel className="aspect-4/5 w-full rounded-xl" />
            <div className="flex gap-2">{[0, 1, 2, 3].map((i) => <Skel key={i} className="h-16 flex-1 rounded-lg" />)}</div>
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-2"><Skel className="h-9 w-64" /><Skel className="h-4 w-48" /></div>
            <SkelText lines={4} className="max-w-2xl" />
            <div className="flex gap-2">{[0, 1, 2].map((i) => <Skel key={i} className="h-6 w-28 rounded-full" />)}</div>
            <div className="space-y-2"><Skel className="h-3 w-32" /><div className="flex gap-2">{[0, 1, 2].map((i) => <Skel key={i} className="h-8 w-32 rounded-full" />)}</div></div>
          </div>
        </div>
        <section className="space-y-3">
          <Skel className="h-6 w-36" />
          <div className="flex gap-4 overflow-hidden">{[0, 1, 2, 3, 4].map((i) => <Skel key={i} className="aspect-2/3 w-36 shrink-0 rounded-xl sm:w-40" />)}</div>
        </section>
      </div>
    </div>
  );
}

/** Мой статус тайтла коротко: «смотрю · 7 серия», «просмотрено». */
function listNote(e: ListEntryWithMedia | undefined): string | null {
  if (!e) return null;
  if (e.status === "watching") return e.episodes ? `смотрю · ${e.episodes} серия` : "смотрю";
  return LIST_LABELS[e.status].toLowerCase();
}

function CharacterPage({ c, crumbs, watching }: { c: CharacterDetails; crumbs: Crumb[]; watching: { id: number; title: string; ep: number } | null }) {
  const { byId: myList } = useList();
  const [shot, setShot] = useState(Math.max(0, c.looks.length - 1));
  const [viewer, setViewer] = useState<number | null>(null);
  const [allNames, setAllNames] = useState(false);
  const [allRels, setAllRels] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const title = c.nameRu ?? c.name;
  const images: GalleryImage[] = c.looks.length
    ? c.looks.map((l) => ({ url: l.image, thumb: l.image, kind: "portrait", source: "AniList", caption: [l.label ?? "облик", l.fromEp ? `с ${l.fromEp} серии` : null].filter(Boolean).join(" · ") }))
    : c.image ? [{ url: c.image, thumb: c.image, kind: "portrait", source: "AniList" }] : [];
  const rels = c.relations.filter((r) => !r.endedEp).sort((a, b) => REL_ORDER.indexOf(a.kind) - REL_ORDER.indexOf(b.kind) || (b.fromEp ?? 0) - (a.fromEp ?? 0));
  const ended = c.relations.filter((r) => r.endedEp);
  const events = [...c.events].sort((a, b) => b.anilistId - a.anilistId || (b.epFrom ?? 0) - (a.epFrom ?? 0));
  const mainNames = [...new Map(c.names.filter((n) => n.kind === "имя").map((n) => [n.name, n])).values()].slice(0, 3);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Breadcrumbs items={crumbs} />
        {/* Пришли из другого сезона — короткий путь в тот, что смотрю */}
        {watching && (
          <Link href={`/anime/${watching.id}`} className="rounded-full px-3 py-1 text-sm tone-accent soft">
            Вы смотрите: {watching.title}{watching.ep ? ` · ${watching.ep} серия` : ""} →
          </Link>
        )}
      </div>
      <div className="space-y-8">
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="w-full shrink-0 md:w-80">
          {images.length ? (
            <Gallery images={images} index={Math.min(shot, images.length - 1)} onIndex={setShot} onOpen={() => setViewer(shot)} portrait />
          ) : (
            <div className="flex aspect-4/5 items-center justify-center rounded-xl bg-gray-800 text-gray-600 ring-1 ring-gray-700"><UserIcon className="h-16 w-16" /></div>
          )}
          {c.futureLooks > 0 && <p className="mt-1 text-xs text-special-300">Ещё {c.futureLooks} — после вашей серии</p>}
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h1 className="text-3xl font-bold">{title}</h1>
            <p className="mt-1 text-sm text-gray-400">{[c.nameRu ? c.name : null, c.native].filter(Boolean).join(" · ")}</p>
          </div>
          {c.aka.length > 0 && (
            <p className="rounded-lg px-3 py-2 text-sm tone-accent soft">
              Он же {c.aka.map((a, i) => <span key={a.href}>{i > 0 && ", "}<b>{a.name}</b> · раскрыто в с. {a.revealedEp}</span>)}
            </p>
          )}
          {c.plotDescription && <p className="leading-relaxed text-gray-200">{c.plotDescription}</p>}
          <div className="flex flex-wrap gap-2">
            {c.groups.filter((g) => !g.past).map((g) => <Badge key={g.id} tone="accent">{g.role ? `${g.name} · ${g.role}` : g.name}</Badge>)}
            {c.goal && <Badge tone="info">цель: {c.goal}</Badge>}
            {c.gender && !c.gender.includes("→") && <Badge tone="neutral">{c.gender === "Female" ? "женский" : c.gender === "Male" ? "мужской" : c.gender}</Badge>}
            {c.age && !c.age.includes("→") && <Badge tone="neutral">возраст: {c.age}</Badge>}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Имена и облики</p>
            <div className="flex flex-wrap items-center gap-2">
              {mainNames.map((n) => <span key={n.name} className="rounded-full bg-gray-800 px-3 py-1 text-sm ring-1 ring-gray-700">{n.name}{n.fromEp ? <span className="text-gray-500"> · с {n.fromEp}</span> : null}</span>)}
              {c.names.length > mainNames.length && (
                <button onClick={() => setAllNames(!allNames)} className="text-sm text-accent-300 hover:text-accent-200">{allNames ? "свернуть" : `все · ${c.names.length}`}</button>
              )}
            </div>
            {allNames && (
              <div className="overflow-hidden rounded-xl ring-1 ring-gray-700">
                <div className="grid grid-cols-[1.4fr_1fr_0.6fr] gap-2 bg-gray-800/60 px-3 py-2 text-[11px] uppercase tracking-wider text-gray-500">
                  <span>Имя или облик</span><span>Кто так зовёт</span><span>Серии</span>
                </div>
                {c.names.map((n, i) => (
                  <div key={i} className="grid grid-cols-[1.4fr_1fr_0.6fr] gap-2 border-t border-gray-800 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><Badge tone={n.kind === "облик" ? "positive" : n.kind === "имя" ? "accent" : "special"}>{n.kind}</Badge><span className="truncate">{n.name}</span></span>
                    <span className="text-gray-400">{n.who ?? "все"}</span>
                    <span className="text-gray-400">{n.fromEp ? `с ${n.fromEp}` : ""}</span>
                  </div>
                ))}
                {c.futureNames > 0 && <p className="border-t border-gray-800 px-3 py-2 text-xs text-special-300">Ещё {c.futureNames} — после вашей серии</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-xl font-bold">Появления <span className="text-base font-normal text-gray-500">{c.appearances.length}</span></h2>
        <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 pt-1">
          {c.appearances.map((a) => (
            <div key={a.media.id} className="w-36 shrink-0 sm:w-40">
              <TitleCard media={a.media} entry={myList.get(a.media.id)} footer={<p className="text-center text-xs text-gray-400">{ROLE_LABEL[a.role]}</p>} />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="mr-auto text-xl font-bold">{allRels ? "Все связи" : "Главные связи"}</h2>
            {rels.length + ended.length > 4 && <button onClick={() => setAllRels(!allRels)} className="text-sm text-accent-300 hover:text-accent-200">{allRels ? "Главные" : `Все связи · ${rels.length + ended.length}`}</button>}
          </div>
          {rels.length + ended.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(allRels ? [...rels, ...ended] : rels.slice(0, 4)).map((r, i) => (
                <Link key={i} href={r.otherHref} className={cx("flex items-center gap-3 rounded-xl bg-gray-800/50 p-2.5 ring-1 ring-gray-700 hover:ring-gray-600", r.endedEp !== null && "opacity-60")}>
                  <span className="relative aspect-2/3 w-10 shrink-0 overflow-hidden rounded-md bg-gray-800">
                    {r.otherImage ? <Img src={r.otherImage} size="thumb" className="absolute inset-0 h-full w-full object-cover object-top" /> : <UserIcon className="m-auto h-full w-5 text-gray-600" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.otherName}</span>
                    <span className="block text-xs text-gray-400">{r.label ? `${r.kind} · ${r.label}` : r.kind}</span>
                    <span className="block text-[11px] text-gray-500">{r.endedEp ? `было: с. ${r.fromEp}–${r.endedEp}` : r.fromEp ? `с ${r.fromEp} серии` : ""}</span>
                  </span>
                </Link>
              ))}
            </div>
          ) : <PlotEmpty />}
        </section>
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="mr-auto text-xl font-bold">{allEvents ? "Все события" : "Последние события"}</h2>
            {events.length > 3 && <button onClick={() => setAllEvents(!allEvents)} className="text-sm text-accent-300 hover:text-accent-200">{allEvents ? "Последние" : `Все события · ${events.length}`}</button>}
          </div>
          {events.length ? (
            <ol className="space-y-3 border-l-2 border-gray-700 pl-4">
              {(allEvents ? events : events.slice(0, 3)).map((e) => (
                <li key={e.id}>
                  <p className="text-xs text-gray-500">{epRange(e.epFrom, e.epTo)}{e.role ? ` · ${e.role}` : ""}</p>
                  {e.key ? <Link href={`/anime/${e.anilistId}/events/${encodeURIComponent(e.key)}`} className={cx("block font-medium hover:text-accent-200", e.major && "text-gray-100")}>{e.title}</Link>
                    : <p className={cx("font-medium", e.major && "text-gray-100")}>{e.title}</p>}
                  {e.summary && <p className="text-sm text-gray-400">{e.summary}</p>}
                </li>
              ))}
            </ol>
          ) : <PlotEmpty />}
        </section>
      </div>

      {c.abilities && c.abilities.length > 0 && (
        <section>
          <h2 className="mb-3 text-xl font-bold">Способности</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {c.abilities.map((a) => (
              <div key={a.name} className="space-y-1 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
                <p className="flex items-center gap-2"><span className="mr-auto text-sm font-semibold">{a.name}</span>
                  <Badge tone={a.status === "постоянная" ? "positive" : a.status === "утрачена" ? "negative" : a.status === "в процессе" ? "warning" : "neutral"}>{a.status}</Badge></p>
                {a.text && <p className="text-xs text-gray-400">{a.text}</p>}
                <p className="text-[11px] text-gray-500">с {a.fromEp} серии</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {c.description && <AnilistDescription text={c.description} gated={c.entityId !== null && (Boolean(c.plotDescription) || c.names.some((n) => n.fromEp !== null) || c.looks.length > 0)} />}

      {viewer !== null && images.length > 0 && <Lightbox images={images} index={Math.min(viewer, images.length - 1)} onIndex={setViewer} onClose={() => setViewer(null)} />}
      </div>
    </div>
  );
}

function PlotEmpty() {
  return (
    <p className="rounded-xl bg-gray-800/40 px-4 py-3 text-sm text-gray-400 ring-1 ring-gray-700">
      Появится после разбора серий — и только до серии, которую вы досмотрели.
    </p>
  );
}
