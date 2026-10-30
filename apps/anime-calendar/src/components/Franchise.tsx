"use client";
import { ChevronDownIcon, SparklesIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { KIND_LABELS as BOOK_KIND_LABELS, type BookLite } from "@/lib/books";
import { api, useFranchise, useTitleCast } from "@/lib/client";
import { adaptLabel, continueAfter, type AdaptForm, type AdaptUnit } from "@/lib/adapt";
import { FORM_LABELS, KIND_LABELS, type FranchiseForm as Form, type FranchiseKind } from "@/lib/franchise";
import { FORMAT_LABELS, label, LIST_LABELS, SOURCE_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import type { FranchiseView as View } from "@/lib/types";
import { Breadcrumbs, useRememberTitle } from "./Breadcrumbs";
import { CharacterCard } from "./Characters";
import { Img } from "./Img";
import { MODE_TONE, useModeTakeover } from "./Mode";
import { Button, cx, ErrorBox, Modal, Skel, Spinner } from "./ui";

// Страница франшизы (IDEAS #80, TASKS 5.10) — центр всех форм: шапка с описанием и «где я» по аниме, манге и ранобэ;
// основная история дорожками по формам (дополнения — на своих местах), ответвления группами по всем формам,
// кроссоверы, персонажи того сезона, где я сейчас. Переключатель режимов в шапке сайта здесь выбирает, что показать.

type Item = View["items"][number];
type BookItem = View["books"][number];

const total = (m: Item["media"]) => m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null);
const formOf = (b: BookLite): Form => (b.kind === "novel" ? "novel" : "manga");
const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
/**
 * Подпись части франшизы без общего названия: остаток названия («Багровые узы», «2» → «Сезон 2»); нет остатка —
 * «Сезон N» у сериалов основной истории, полное название у прочих.
 */
function partNames(items: Item[], name: string): Map<number, string> {
  const out = new Map<number, string>();
  let season = 0;
  for (const i of items) {
    const full = displayTitle(i.media.title);
    const series = i.kind === "main" && ["TV", "TV_SHORT", "ONA"].includes(i.media.format ?? "");
    if (series) season++;
    const rest = full.toLowerCase().startsWith(name.toLowerCase()) ? full.slice(name.length).replace(/^[\s:.,\-–—]+/, "").trim() : null;
    // «2», «2. Часть 2», «2nd Season» → «Сезон 2», «Сезон 2 · Часть 2»
    const num = rest?.match(/^(\d+)(?:\.|nd season|rd season|th season)?\s*(.*)$/i);
    out.set(i.media.id, num ? [`Сезон ${num[1]}`, num[2]].filter(Boolean).join(" · ") : rest || (series ? `Сезон ${season}` : full));
  }
  return out;
}
const reading = (s?: string) => s === "watching" || s === "rewatching";
// Цвет полосы прогресса и подписи формы — по тону режима
const BAR: Record<Form, string> = { anime: "bg-special-400", manga: "bg-warning-400", novel: "bg-positive-400" };

export function FranchiseView({ id }: { id: number }) {
  const router = useRouter();
  const { data, error, isLoading } = useFranchise(id);
  const [form, setForm] = useState<Form | null>(null);
  const [branches, setBranches] = useState(true);
  // Переключатель режимов в шапке сайта — фильтр форм этой страницы (повторный выбор — снова все)
  const pick = useCallback((m: Form) => setForm((f) => (f === m ? null : m)), []);
  useModeTakeover(form, pick);
  // Открыли по любому тайтлу франшизы — адрес по корню (одна страница на франшизу)
  useEffect(() => { if (data && data.root !== id) router.replace(`/franchise/${data.root}`); }, [data, id, router]);
  useRememberTitle(data?.castTitle ?? id);
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <FranchiseSkeleton />;
  return <Loaded data={data} form={form} setForm={setForm} branches={branches} setBranches={setBranches} />;
}

function Loaded({ data, form, setForm, branches, setBranches }: {
  data: View; form: Form | null; setForm: (f: Form | null) => void; branches: boolean; setBranches: (b: boolean) => void;
}) {
  const name = displayTitle(data.title);
  const anime = new Map(data.items.map((i) => [i.media.id, i]));
  const parts = partNames(data.items, name);
  const books = new Map(data.books.map((b) => [b.book.id, b]));
  const sourceForm: Form | null = data.sourceBook ? formOf(books.get(data.sourceBook)!.book) : null;
  // Дорожки: первоисточник первым, дальше по порядку «ранобэ → манга → аниме»
  const forms = (["novel", "manga", "anime"] as Form[]).sort((a, b) => Number(b === sourceForm) - Number(a === sourceForm))
    .filter((f) => (f === "anime" ? data.items.length : data.books.some((b) => formOf(b.book) === f)));
  const show = (f: Form) => form === null || form === f;
  const lane = (f: Form) => (f === "anime" ? data.items.filter((i) => i.kind === "main" || i.kind === "side").length
    : data.books.filter((b) => formOf(b.book) === f && (b.kind === "main" || b.kind === "side")).length);
  const branchList = data.branches.filter((g) => form === null || g.ids.some((x) => (anime.has(x) ? "anime" : books.has(x) ? formOf(books.get(x)!.book) : null) === form));
  const rootHref = data.castTitle !== null ? `/anime/${data.root}` : `/manga/${data.root}`;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Hero data={data} name={name} parts={parts} forms={forms} sourceForm={sourceForm} rootHref={rootHref} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-gray-400">Показать:</span>
        <button type="button" onClick={() => setForm(null)} className={cx("rounded-full px-3.5 py-1.5 text-sm font-medium tone-accent", form === null ? "solid" : "outline-tone")}>Все формы</button>
        {forms.map((f) => (
          <button key={f} type="button" onClick={() => setForm(form === f ? null : f)}
            className={cx("rounded-full px-3.5 py-1.5 text-sm font-medium", MODE_TONE[f], form === f ? "solid" : "outline-tone")}>
            {FORM_LABELS[f]}
          </button>
        ))}
        {data.branches.length > 0 && (
          <button type="button" onClick={() => setBranches(!branches)} className="ml-auto rounded-full px-3.5 py-1.5 text-sm text-gray-300 ring-1 ring-gray-700 hover:bg-gray-800">
            {branches ? "Скрыть ответвления" : `Ответвления (${data.branches.length})`}
          </button>
        )}
      </div>

      <section className="space-y-5">
        <h2 className="text-xl font-bold">Основная история <span className="text-base font-normal text-gray-500">по выходу</span></h2>
        {forms.filter(show).filter((f) => lane(f) > 0).map((f) => (
          <Lane key={f} form={f} note={f === sourceForm ? "первоисточник" : f === "anime" ? "экранизация" : sourceForm ? "адаптация" : null}
            action={f === "anime" && data.books.length > 0 ? <AdaptEditor data={data} parts={parts} /> : null}>
            {f === "anime"
              ? data.items.filter((i) => i.kind === "main" || i.kind === "side").map((i) => <AnimeCard key={i.media.id} it={i} part={parts.get(i.media.id)!} next={i.media.id === data.next} />)
              : data.books.filter((b) => formOf(b.book) === f && (b.kind === "main" || b.kind === "side")).map((b) => <BookCard key={b.book.id} it={b} />)}
          </Lane>
        ))}
        {show("anime") && data.castTitle !== null && anime.get(data.castTitle)?.plot && (
          <CurrentArcs it={anime.get(data.castTitle)!} part={parts.get(data.castTitle)!} />
        )}
      </section>

      {branches && branchList.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-bold">Ответвления <span className="text-base font-normal text-gray-500">спин-оффы, другие версии, пересказы</span></h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {branchList.map((g) => <Branch key={g.ids[0]} kind={g.kind} ids={g.ids} anime={anime} books={books} />)}
          </div>
        </section>
      )}

      {branches && data.crossovers.length > 0 && show("anime") && (
        <section className="space-y-3">
          <h2 className="text-xl font-bold">Кроссоверы</h2>
          <div className="grid gap-3 lg:grid-cols-2">{data.crossovers.map((c) => <Crossover key={c.media.id} c={c} />)}</div>
        </section>
      )}

      {data.partial && <p className="flex items-center gap-2 text-sm text-gray-400"><Spinner className="h-4 w-4" />Догружаем связанные тайтлы и книги — страница дополнится сама.</p>}

      {data.castTitle !== null && <Cast id={data.castTitle} title={anime.get(data.castTitle)?.media.title} />}
    </div>
  );
}

// ---------------------------------------------------------------- шапка

/** Шапка: обложки форм на фоне баннера, название, состав, описание и «где я» по каждой форме. */
function Hero({ data, name, parts, forms, sourceForm, rootHref }: {
  data: View; name: string; parts: Map<number, string>; forms: Form[]; sourceForm: Form | null; rootHref: string;
}) {
  const firstMain = (f: Form) => (f === "anime" ? data.items.find((i) => i.kind === "main")?.media.coverImage.large
    : data.books.find((b) => formOf(b.book) === f && b.kind === "main")?.book.coverImage.large);
  const covers = forms.map(firstMain).filter((c): c is string => Boolean(c)).slice(0, 3);
  const years = [...data.items.map((i) => i.media.startDate.year), ...data.books.map((b) => b.book.year)].filter((y): y is number => Boolean(y));
  const mangas = data.books.filter((b) => formOf(b.book) === "manga").length;
  const novels = data.books.filter((b) => formOf(b.book) === "novel").length;
  const src = sourceForm ? FORM_LABELS[sourceForm].toLowerCase() : label(SOURCE_LABELS, data.items.find((i) => i.media.id === data.root)?.media.source ?? null)?.toLowerCase();
  const facts = [
    src ? `Первоисточник — ${src}` : null,
    data.items.length ? plural(data.items.length, "аниме", "аниме", "аниме") : null,
    mangas ? plural(mangas, "манга", "манги", "манг") : null,
    novels ? plural(novels, "ранобэ", "ранобэ", "ранобэ") : null,
    data.crossovers.length ? plural(data.crossovers.length, "кроссовер", "кроссовера", "кроссоверов") : null,
  ].filter(Boolean);
  return (
    <header className="relative -mx-4 overflow-hidden px-4 pb-6 pt-4 sm:mx-0 sm:rounded-2xl sm:px-6 sm:ring-1 sm:ring-gray-800">
      {data.banner && <Img src={data.banner} size="full" upscale={false} className="absolute inset-0 -z-10 h-full w-full object-cover opacity-25 blur-sm" />}
      <div className="absolute inset-0 -z-10 bg-linear-to-b from-gray-900/40 via-gray-900/80 to-gray-900" />
      <Breadcrumbs items={[{ label: name, href: rootHref }, { label: "Франшиза" }]} />
      <div className="mt-4 flex flex-col gap-6 md:flex-row md:items-start">
        {covers.length > 0 && (
          <div className="flex shrink-0 justify-center">
            {covers.map((c, i) => (
              <Img key={c} src={c} size="card" className={cx("aspect-2/3 w-28 rounded-xl object-cover shadow-2xl ring-2 ring-gray-900 sm:w-36 lg:w-40", i > 0 && "-ml-14 sm:-ml-18")} />
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm text-accent-300">Франшиза{years.length ? ` · с ${Math.min(...years)} года` : ""}</p>
            <h1 className="text-2xl font-bold leading-tight sm:text-4xl">{name}</h1>
            {facts.length > 0 && <p className="mt-1 text-sm text-gray-400">{facts.join(" · ")}</p>}
          </div>
          {data.about && <About about={data.about} />}
          <div className="flex flex-wrap gap-2 text-sm">
            {data.castTitle !== null && <Link href={`/anime/${data.castTitle}/characters`} className="rounded-lg px-3 py-1.5 ring-1 ring-gray-700 hover:bg-gray-800">Персонажи</Link>}
            {data.castTitle !== null && <Link href={`/anime/${data.castTitle}/events`} className="rounded-lg px-3 py-1.5 ring-1 ring-gray-700 hover:bg-gray-800">Сюжет и события</Link>}
            <Link href={data.castTitle !== null ? `/franchise/${data.root}/glossary` : `/manga/${data.root}/glossary`} className="rounded-lg px-3 py-1.5 ring-1 ring-gray-700 hover:bg-gray-800">Глоссарий</Link>
          </div>
        </div>
      </div>
      <Where data={data} parts={parts} forms={forms} />
    </header>
  );
}

function About({ about }: { about: NonNullable<View["about"]> }) {
  const [open, setOpen] = useState(false);
  const long = about.text.length > 360;
  return (
    <div className="max-w-3xl space-y-1">
      <p className={cx("whitespace-pre-line leading-relaxed text-gray-200", long && !open && "line-clamp-4")}>{about.text}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        {long && (
          <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-0.5 text-accent-300 hover:text-accent-200">
            {open ? "Свернуть" : "Читать полностью"}<ChevronDownIcon className={cx("h-3.5 w-3.5 transition", open && "rotate-180")} />
          </button>
        )}
        <span className="flex items-center gap-1">
          {about.by === "ai" && <SparklesIcon className="h-3.5 w-3.5" />}
          {about.by === "ai" ? "описание франшизы составлено ИИ" : about.by === "book" ? "описание первоисточника" : "описание первого сезона"}
        </span>
      </div>
    </div>
  );
}

type Spot = { form: Form; state: string; detail: string | null; pct: number; action: string; href: string };

/** Где я по каждой форме: что смотрю или читаю, сколько, куда дальше. */
function whereOf(data: View, parts: Map<number, string>, f: Form): Spot | null {
  if (f === "anime") {
    const story = data.items.filter((i) => i.kind === "main" || i.kind === "side");
    if (!story.length) return null;
    const cur = story.find((i) => reading(i.entry?.status));
    const next = story.find((i) => i.media.id === data.next);
    const done = story.filter((i) => i.entry?.status === "completed").length;
    const pct = data.progress.total ? data.progress.watched / data.progress.total : 0;
    if (cur) {
      const t = total(cur.media);
      return { form: f, state: parts.get(cur.media.id)!, detail: `серия ${cur.entry!.episodes}${t ? ` из ${t}` : ""}`, pct, action: `Смотреть серию ${cur.entry!.episodes + 1}`, href: `/anime/${cur.media.id}` };
    }
    if (next) return { form: f, state: done ? `Дальше: ${parts.get(next.media.id)}` : "Не начато", detail: done ? `просмотрено ${done} из ${story.length}` : null, pct, action: done ? "Смотреть дальше" : "Начать", href: `/anime/${next.media.id}` };
    return { form: f, state: done ? "Всё просмотрено" : "Пока не вышло", detail: null, pct, action: "К первому сезону", href: `/anime/${story[0].media.id}` };
  }
  const story = data.books.filter((b) => formOf(b.book) === f && (b.kind === "main" || b.kind === "side"));
  if (!story.length) return null;
  const main = story.filter((b) => b.kind === "main");
  const cur = story.find((b) => reading(b.entry?.status)) ?? main.find((b) => b.entry && b.entry.status !== "completed" && b.entry.status !== "dropped" && b.entry.chapters > 0);
  if (cur) {
    const c = cur.entry!.chapters;
    return { form: f, state: bookTitle(cur.book), detail: `глава ${c}${cur.known ? ` из ${cur.known}` : ""}`, pct: cur.known ? Math.min(1, c / cur.known) : 0, action: `Читать гл. ${c + 1}`, href: `/manga/${cur.book.id}` };
  }
  const left = main.find((b) => b.entry?.status !== "completed") ?? null;
  // Досмотренные сезоны уже прошли часть книги — читать дальше аниме
  const after = continueAfter(data.items.filter((i) => i.adapt && i.entry?.status === "completed").map((i) => i.adapt!), f);
  if (left && !left.entry && after) {
    const where = after.unit === "vol" ? `тома ${after.from}` : `главы ${after.from}`;
    return { form: f, state: `Дальше аниме — с ${where}`, detail: bookTitle(left.book), pct: 0, action: `Читать с ${where}`, href: `/manga/${left.book.id}` };
  }
  if (!left) return { form: f, state: "Всё прочитано", detail: null, pct: 1, action: "К книге", href: `/manga/${main[0]?.book.id ?? story[0].book.id}` };
  const ru = left.ru ? `на русском ${plural(left.ru.count, "глава", "главы", "глав")}` : null;
  return { form: f, state: "Не начато", detail: [bookTitle(left.book), ru].filter(Boolean).join(" · "), pct: 0, action: "Начать читать", href: `/manga/${left.book.id}` };
}

function Where({ data, parts, forms }: { data: View; parts: Map<number, string>; forms: Form[] }) {
  const spots = forms.map((f) => whereOf(data, parts, f)).filter((s): s is Spot => Boolean(s));
  if (!spots.length) return null;
  return (
    <div className={cx("mt-6 grid gap-3", spots.length > 1 && "sm:grid-cols-2", spots.length > 2 && "lg:grid-cols-3")}>
      {spots.map((s) => (
        <div key={s.form} className={cx("flex flex-col gap-2 rounded-xl bg-gray-900/70 p-3.5 ring-1 ring-gray-700 backdrop-blur", MODE_TONE[s.form])}>
          <span className="text-xs font-semibold uppercase tracking-wide tone-text">{FORM_LABELS[s.form]}</span>
          <div className="min-w-0">
            <p className="truncate font-medium text-gray-100">{s.state}</p>
            {s.detail && <p className="truncate text-sm text-gray-400">{s.detail}</p>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-800"><div className={cx("h-full rounded-full", BAR[s.form])} style={{ width: `${Math.round(s.pct * 100)}%` }} /></div>
          <Link href={s.href} className="mt-auto self-start rounded-lg px-3 py-1.5 text-sm font-semibold solid">{s.action}</Link>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- дорожки

function Lane({ form, note, action, children }: { form: Form; note: string | null; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cx("space-y-2", MODE_TONE[form])}>
      <div className="flex items-baseline gap-2">
        <span className="font-semibold tone-text">{FORM_LABELS[form]}</span>
        {note && <span className="text-sm text-gray-500">{note}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">{children}</div>
    </div>
  );
}

const card = "flex w-60 shrink-0 gap-3 rounded-xl bg-gray-800/50 p-2.5 ring-1 transition hover:bg-gray-800";

/** Сколько я посмотрел: «просмотрено», «7 из 12», «запланировано». */
function entryNote(it: Item): string | null {
  const e = it.entry;
  if (!e) return null;
  if (e.status === "completed") return LIST_LABELS.completed.toLowerCase();
  const t = total(it.media);
  if (e.episodes > 0) return `${LIST_LABELS[e.status].toLowerCase()} · ${e.episodes}${t ? ` из ${t}` : ""}`;
  return LIST_LABELS[e.status].toLowerCase();
}

function AnimeCard({ it, part, next }: { it: Item; part: string; next: boolean }) {
  const m = it.media;
  const t = total(m);
  const done = it.entry?.status === "completed" ? 1 : t && it.entry ? Math.min(1, it.entry.episodes / t) : 0;
  const side = it.kind !== "main";
  return (
    <Link href={`/anime/${m.id}`} className={cx(card, side && "w-52", next || reading(it.entry?.status) ? "ring-special-400/70" : "ring-gray-700")}>
      <Cover src={m.coverImage.large} small={side} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-gray-400">{[label(FORMAT_LABELS, m.format), m.startDate.year].filter(Boolean).join(" · ")}{side ? " · доп." : ""}</span>
        <span title={displayTitle(m.title)} className="line-clamp-2 text-sm font-semibold leading-snug text-gray-100">{part}</span>
        <span className="text-xs text-gray-500">{[t ? `${t} сер.` : null, m.status === "RELEASING" ? "выходит" : m.status === "NOT_YET_RELEASED" ? "анонс" : null, entryNote(it)].filter(Boolean).join(" · ")}</span>
        {it.adapt && <span className={cx("text-xs", it.adapt.form === "novel" ? "text-positive-300" : "text-warning-300")} title={it.adapt.source === "fandom" ? "по вики Fandom" : "поправлено вручную"}>{adaptLabel(it.adapt)}</span>}
        <Progress pct={done} form="anime" />
      </div>
    </Link>
  );
}

const bookTitle = (b: BookLite) => b.title.ru || b.title.romaji || b.title.english || String(b.id);
const BOOK_STATUS: Record<string, string> = { RELEASING: "выходит", FINISHED: "завершена", HIATUS: "перерыв", NOT_YET_RELEASED: "анонс", CANCELLED: "прервана" };

function BookCard({ it }: { it: BookItem }) {
  const b = it.book;
  const side = it.kind !== "main";
  const read = it.entry ? (it.entry.status === "completed" ? 1 : it.known ? Math.min(1, it.entry.chapters / it.known) : 0) : 0;
  return (
    <Link href={`/manga/${b.id}`} className={cx(card, side && "w-52", reading(it.entry?.status) ? (formOf(b) === "novel" ? "ring-positive-400/70" : "ring-warning-400/70") : "ring-gray-700")}>
      <Cover src={b.coverImage.large} small={side} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs text-gray-400">{[BOOK_KIND_LABELS[b.kind], b.year].filter(Boolean).join(" · ")}{side ? " · доп." : ""}</span>
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-gray-100">{bookTitle(b)}</span>
        <span className="text-xs text-gray-500">
          {[it.known ? `${it.known} гл.` : b.volumes ? `${b.volumes} т.` : null, b.status ? BOOK_STATUS[b.status] : null,
            it.ru ? `RU ${it.ru.last ? `до ${it.ru.last}` : it.ru.count}` : null,
            it.entry ? (it.entry.status === "completed" ? "прочитано" : it.entry.chapters ? `я на гл. ${it.entry.chapters}` : null) : null].filter(Boolean).join(" · ")}
        </span>
        <Progress pct={read} form={formOf(b)} />
      </div>
    </Link>
  );
}

const Cover = ({ src, small }: { src: string | null; small?: boolean }) => (
  <div className={cx("relative shrink-0 overflow-hidden rounded-lg bg-gray-800", small ? "h-20 w-14" : "h-24 w-16")}>
    {src && <Img src={src} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
  </div>
);

const Progress = ({ pct, form }: { pct: number; form: Form }) => (
  <div className="mt-auto h-1 overflow-hidden rounded-full bg-gray-700">{pct > 0 && <div className={cx("h-full rounded-full", BAR[form])} style={{ width: `${Math.round(pct * 100)}%` }} />}</div>
);

/** Арки сезона, где я сейчас, на мой прогресс: что уже было (ссылки на события), сколько событий впереди — без названий. */
function CurrentArcs({ it, part }: { it: Item; part: string }) {
  const plot = it.plot!;
  const id = it.media.id;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-gray-800/40 px-3 py-2 text-xs ring-1 ring-gray-700">
      <span className="text-gray-400">{part} — арки:</span>
      {!plot.arcs.length && !plot.events && <span className="text-gray-500">откроются с первой просмотренной серией</span>}
      {plot.arcs.map((a) => (
        <Link key={a.name} href={`/anime/${id}/events`} className="rounded-full bg-gray-700/60 px-2 py-0.5 text-gray-200 hover:bg-gray-700">
          {a.name}{a.fromEp ? <span className="text-gray-400"> · с {a.fromEp} сер.</span> : null}
        </Link>
      ))}
      {plot.ahead > 0 && <span className="text-gray-500">ещё {plural(plot.ahead, "событие", "события", "событий")} впереди</span>}
    </div>
  );
}

// ---------------------------------------------------------------- ответвления и кроссоверы

const BRANCH_LABELS: Partial<Record<FranchiseKind, string>> = { spinoff: "Спин-офф", alt: "Другая версия", recap: "Пересказ" };

/** Ответвление: все его формы одной карточкой, состояние — по моему прогрессу. */
function Branch({ kind, ids, anime, books }: { kind: FranchiseKind; ids: number[]; anime: Map<number, Item>; books: Map<number, BookItem> }) {
  const parts = ids.map((x) => {
    const a = anime.get(x);
    if (a) return { id: x, href: `/anime/${x}`, form: "anime" as Form, title: displayTitle(a.media.title), cover: a.media.coverImage.large,
      what: [label(FORMAT_LABELS, a.media.format), total(a.media) ? `${total(a.media)} сер.` : null].filter(Boolean).join(" "), started: Boolean(a.entry && a.entry.status !== "planned"), done: a.entry?.status === "completed" };
    const b = books.get(x)!;
    return { id: x, href: `/manga/${x}`, form: formOf(b.book), title: bookTitle(b.book), cover: b.book.coverImage.large,
      what: [BOOK_KIND_LABELS[b.book.kind], b.known ? `${b.known} гл.` : b.book.volumes ? `${b.book.volumes} т.` : null].filter(Boolean).join(" "), started: Boolean(b.entry && b.entry.status !== "planned"), done: b.entry?.status === "completed" };
  });
  const head = parts[0];
  const state = parts.every((p) => p.done) ? "пройдено" : parts.some((p) => p.started) ? "начато" : "не начато";
  return (
    <div className="flex gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <Link href={head.href} className="shrink-0"><Cover src={head.cover} /></Link>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs text-gray-400">{BRANCH_LABELS[kind] ?? KIND_LABELS[kind]} · <span className={state === "не начато" ? "text-gray-500" : "text-positive-300"}>{state}</span></p>
        <Link href={head.href} className="line-clamp-2 text-sm font-semibold leading-snug hover:text-accent-200">{head.title}</Link>
        <div className="flex flex-wrap gap-1">
          {parts.map((p) => (
            <Link key={p.id} href={p.href} title={p.title} className={cx("rounded-full px-2 py-0.5 text-xs soft", MODE_TONE[p.form])}>{p.what}</Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function Crossover({ c }: { c: View["crossovers"][number] }) {
  const t = total(c.media);
  return (
    <div className="flex gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <Link href={`/anime/${c.media.id}`} className="shrink-0"><Cover src={c.media.coverImage.large} /></Link>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Link href={`/anime/${c.media.id}`} className="block font-semibold leading-snug hover:text-accent-200">{displayTitle(c.media.title)}</Link>
        <p className="text-xs text-gray-400">{[label(FORMAT_LABELS, c.media.format), c.media.startDate.year, t ? `${t} сер.` : null].filter(Boolean).join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-gray-500">Также во франшизах:</span>
          {c.others.slice(0, 6).map((o) => (
            <Link key={o.id} href={`/franchise/${o.id}`} className="rounded-full px-2 py-0.5 text-gray-300 ring-1 ring-gray-700 hover:bg-gray-800">{displayTitle(o.title)}</Link>
          ))}
          {c.others.length > 6 && <span className="text-gray-500">+{c.others.length - 6}</span>}
        </div>
      </div>
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
    <div className="mx-auto max-w-6xl space-y-6" aria-busy>
      <div className="flex gap-6"><Skel className="h-56 w-40 rounded-xl" /><div className="flex-1 space-y-3"><Skel className="h-4 w-48" /><Skel className="h-10 w-96 max-w-full" /><Skel className="h-20 w-full" /></div></div>
      <div className="flex gap-3">{Array.from({ length: 4 }, (_, i) => <Skel key={i} className="h-28 w-60 shrink-0 rounded-xl" />)}</div>
    </div>
  );
}

// ---------------------------------------------------------------- что адаптирует сезон

/** Правка «сезон ↔ тома или главы книги»: вручную важнее вики Fandom; пусто — убрать свою правку. */
function AdaptEditor({ data, parts }: { data: View; parts: Map<number, string> }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const seasons = data.items.filter((i) => i.kind === "main" || i.kind === "side");
  const defForm: AdaptForm = data.sourceBook && data.books.find((b) => b.book.id === data.sourceBook)?.book.kind !== "novel" ? "manga" : "novel";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-gray-400 hover:text-gray-200">Что из книги в каждом сезоне</button>
      {open && (
        <Modal open onClose={() => { setOpen(false); void qc.invalidateQueries({ queryKey: ["franchise"] }); }} title="Сезоны и книга" wide>
          <p className="mb-3 text-sm text-gray-400">Какие тома или главы книги адаптирует сезон. Данные с вики Fandom подставляются сами, ваша правка важнее. По ним плитка «где я» подскажет, с какого места читать после аниме.</p>
          <div className="space-y-2">
            {seasons.map((i) => <AdaptRow key={i.media.id} it={i} part={parts.get(i.media.id)!} defForm={defForm} />)}
          </div>
        </Modal>
      )}
    </>
  );
}

function AdaptRow({ it, part, defForm }: { it: View["items"][number]; part: string; defForm: AdaptForm }) {
  const a = it.adapt;
  const [form, setForm] = useState<AdaptForm>(a?.form ?? defForm);
  const [unit, setUnit] = useState<AdaptUnit>(a?.unit ?? "vol");
  const [from, setFrom] = useState(a ? String(a.from) : "");
  const [to, setTo] = useState(a ? String(a.to) : "");
  const [state, setState] = useState<"idle" | "busy" | "saved" | Error>("idle");
  const save = async (clear = false) => {
    setState("busy");
    try {
      await api("/api/franchise/adapt", { method: "PUT", json: clear ? { anime: it.media.id, clear: true } : { anime: it.media.id, form, unit, from: Number(from), to: Number(to) } });
      if (clear) { setFrom(""); setTo(""); }
      setState("saved");
    } catch (e) { setState(e as Error); }
  };
  const field = "h-8 rounded-md border border-gray-600 bg-gray-800 px-2 text-sm focus:border-accent-500 focus:outline-none";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-800/40 p-2 ring-1 ring-gray-700">
      <span className="min-w-40 flex-1 text-sm">{part} <span className="text-xs text-gray-500">{it.media.startDate.year}{a ? ` · ${a.source === "fandom" ? "Fandom" : "вручную"}` : ""}</span></span>
      <select value={form} onChange={(e) => setForm(e.target.value as AdaptForm)} className={field}><option value="novel">ранобэ</option><option value="manga">манга</option></select>
      <select value={unit} onChange={(e) => setUnit(e.target.value as AdaptUnit)} className={field}><option value="vol">тома</option><option value="ch">главы</option></select>
      <input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" placeholder="с" className={cx(field, "w-16")} />
      <input value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" placeholder="по" className={cx(field, "w-16")} />
      <Button size="sm" disabled={!from || !to || state === "busy"} onClick={() => void save()}>{state === "saved" ? "Сохранено" : "Сохранить"}</Button>
      {a?.source === "manual" && <Button size="sm" variant="ghost" onClick={() => void save(true)}>Убрать</Button>}
      {state instanceof Error && <span className="w-full text-xs text-negative-300">{state.message}</span>}
    </div>
  );
}
