"use client";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, BellAlertIcon, BellSlashIcon, BookOpenIcon, CheckIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  chapterName, EDITION_LABELS, KIND_LABELS, LANG_LABELS, pickTranslation, READ_LABELS, translationLabel,
  type BookHit, type BookLite, type BookPage, type ChapterSummary, type Edition, type EditionSummary,
} from "@/lib/books";
import { GENRE_LABELS, label } from "@/lib/labels";
import type { BookCharacter } from "@/server/books/anilist-books";
import { api, useBook, useBookProgress } from "@/lib/client";
import { FranchiseChip } from "../FranchiseChip";
import { Discussion } from "../Discussion";
import { Img } from "../Img";
import { Grid } from "./BooksHome";
import { useDeclareMode } from "../Mode";
import { Badge, Button, cx, ErrorBox, Modal, Skel, Spinner } from "../ui";

// Страница книги (манга, манхва, ранобэ): что вышло в оригинале и в переводах, каких глав нет на русском, оглавление
// с выбором перевода, провайдеры (что нашлось и где; не та книга — привязать вручную), связи с аниме.

const PROVIDER_NAMES: Record<string, string> = { ranobelib: "RanobeLib", mangalib: "MangaLib", mangadex: "MangaDex", syosetu: "Syosetu", lnreader: "LNReader", suwayomi: "Suwayomi", ai: "" };
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

/** Ссылка на ридер главы. */
export const readHref = (bookId: number, edition: Edition, c: Pick<ChapterSummary, "key">, t: { provider: string; cref: string }) =>
  `/manga/${bookId}/read?e=${edition}&c=${encodeURIComponent(c.key)}&p=${t.provider}&r=${encodeURIComponent(t.cref)}`;

const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

export function BookView({ id }: { id: number }) {
  const { data, error, isLoading } = useBook(id);
  const { data: progress } = useBookProgress(id);
  useDeclareMode(data ? (data.book.kind === "novel" ? "novel" : "manga") : null);
  if (isLoading) return <div className="mx-auto max-w-6xl space-y-4"><Skel className="h-56 w-full" /><Skel className="h-40 w-full" /></div>;
  if (error || !data) return <ErrorBox error={error ?? "Книга не найдена"} />;
  return <Loaded page={data} progress={progress ?? null} />;
}

function Loaded({ page, progress }: { page: BookPage; progress: ReturnType<typeof useBookProgress>["data"] | null }) {
  const { book, origin, editions } = page;
  const qc = useQueryClient();
  const name = book.title.ru || book.title.romaji || book.title.english || "";
  const [edition, setEdition] = useState<Edition | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const ed = editions.find((e) => e.edition === edition) ?? editions[0];
  const pref = progress?.pref ?? {};
  // Продолжить: последняя открытая глава (недочитанная — она же, дочитанная — следующая)
  const resume = useMemo(() => {
    const last = progress?.positions[0];
    const e = editions.find((x) => x.edition === last?.edition) ?? editions[0];
    if (!e?.chapters.length) return null;
    let i = last ? e.chapters.findIndex((c) => c.key === last.chapter) : -1;
    if (i >= 0 && last?.done) i = Math.min(i + 1, e.chapters.length - 1);
    const c = e.chapters[Math.max(0, i)];
    const t = pickTranslation(c, pref);
    return t ? { href: readHref(book.id, e.edition, c, t), label: i >= 0 ? `Продолжить: ${chapterName(c, e.edition)}` : "Читать с начала" } : null;
  }, [progress, editions, pref, book.id]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Шапка */}
      <div className="flex flex-col gap-5 sm:flex-row">
        {book.coverImage.large && <Img src={book.coverImage.large} size="card" className="h-72 w-48 shrink-0 self-center rounded-xl object-cover shadow-xl ring-1 ring-gray-700 sm:self-start" />}
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">{name}</h1>
            <p className="text-sm text-gray-400">{[book.title.romaji, book.title.native].filter((t) => t && t !== name).join(" · ")}</p>
          </div>
          <FranchiseChip id={book.id} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="accent">{KIND_LABELS[book.kind]}</Badge>
            {book.year && <span className="text-gray-400">{book.year}</span>}
            {book.authors.length > 0 && <span className="text-gray-400">{book.authors.slice(0, 2).map((a) => a.name).join(", ")}</span>}
            {book.averageScore && <span className="text-gray-300">★ {(book.averageScore / 10).toFixed(1)}</span>}
          </div>
          {/* Выход: оригинал и переводы */}
          <div className="space-y-1.5 rounded-xl bg-gray-800/50 p-3 text-sm ring-1 ring-gray-700">
            <p>
              <span className="text-gray-400">Оригинал: </span>
              <span className="text-gray-100">{origin.status ?? "нет данных"}</span>
              {origin.url && <a href={origin.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-300">{origin.source}<ArrowTopRightOnSquareIcon className="h-3 w-3" /></a>}
            </p>
            {editions.map((e) => <EditionLine key={e.edition} e={e} multi={editions.length > 1} />)}
            {!editions.length && <p className="text-gray-500">{page.updating ? "Ищу главы у провайдеров…" : "Глав у провайдеров не нашлось — можно привязать книгу вручную ниже."}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {resume && <Link href={resume.href}><Button variant="primary"><BookOpenIcon className="h-4 w-4" />{resume.label}</Button></Link>}
            <ReadControl bookId={book.id} entry={progress?.entry ?? null} />
            <ChapterAlerts bookId={book.id} reading={progress?.entry?.status === "watching" || progress?.entry?.status === "rewatching"} />
            <Link href={`/manga/${book.id}/glossary`}><Button variant="ghost">Глоссарий</Button></Link>
            {page.updating && <span className="flex items-center gap-1.5 text-xs text-gray-400"><Spinner className="h-3.5 w-3.5" />обновляю у провайдеров</span>}
          </div>
        </div>
      </div>

      <nav aria-label="Разделы книги" className="-mx-1 flex gap-1 overflow-x-auto border-b border-gray-800 px-1">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cx("shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition", tab === t.id ? "border-accent-400 text-white" : "border-transparent text-gray-400 hover:text-gray-200")}>
            {t.label}{t.id === "chapters" && ed ? <span className="ml-1 text-gray-500">{ed.chapters.length}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-6">
            {(book.descriptionRu || book.description) && (
              <section className="space-y-1">
                <h2 className="text-lg font-bold">Описание</h2>
                <p className="whitespace-pre-line text-sm leading-relaxed text-gray-300">{book.descriptionRu ?? stripHtml(book.description ?? "")}</p>
              </section>
            )}
            {book.genres.length > 0 && <p className="flex flex-wrap gap-1.5">{book.genres.map((g) => <Badge key={g}>{label(GENRE_LABELS, g)}</Badge>)}</p>}
            <Related page={page} />
          </div>
          <aside className="space-y-4">
            <Providers page={page} onChange={() => void qc.invalidateQueries({ queryKey: ["book", book.id] })} />
          </aside>
        </div>
      )}
      {tab === "chapters" && (ed ? (
        <section className="space-y-2">
          {editions.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {editions.map((e) => (
                <button key={e.edition} onClick={() => setEdition(e.edition)}
                  className={cx("rounded-full px-3 py-1 text-xs", e.edition === ed.edition ? "tone-accent solid" : "bg-gray-800 text-gray-300 hover:bg-gray-700")}>
                  {EDITION_LABELS[e.edition]}
                </button>
              ))}
            </div>
          )}
          <ChapterList bookId={book.id} ed={ed} pref={pref} read={new Map((progress?.positions ?? []).filter((p) => p.edition === ed.edition).map((p) => [p.chapter, p.done]))} />
        </section>
      ) : <p className="text-sm text-gray-500">Глав пока нет — проверьте провайдеров на вкладке «Обзор».</p>)}
      {tab === "characters" && <BookCharacters id={book.id} />}
      {tab === "similar" && <SimilarBooks id={book.id} />}
      {tab === "discussion" && <Discussion anilistId={book.id} />}
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Обзор" }, { id: "chapters", label: "Главы" }, { id: "characters", label: "Персонажи" },
  { id: "similar", label: "Похожее" }, { id: "discussion", label: "Обсуждение" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Персонажи книги: главные первыми, имя по-русски (Shikimori), если есть. */
function BookCharacters({ id }: { id: number }) {
  const { data, error, isLoading } = useQuery({ queryKey: ["book-chars", id], queryFn: () => api<{ characters: BookCharacter[] }>(`/api/books/${id}/characters`), staleTime: 3600_000 });
  if (error) return <ErrorBox error={error} />;
  if (isLoading) return <Skel className="h-60 w-full" />;
  if (!data?.characters.length) return <p className="text-sm text-gray-500">О персонажах этой книги данных нет.</p>;
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
      {data.characters.map((c) => (
        <div key={c.id} className="space-y-1 text-center">
          <div className="relative aspect-2/3 overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700">
            {c.image && <Img src={c.image} size="card" className="absolute inset-0 h-full w-full object-cover" />}
            {c.main && <span className="absolute left-1 top-1 rounded-full bg-gray-900/80 px-1.5 text-[10px] font-semibold uppercase text-gray-200">главный</span>}
          </div>
          <p className="line-clamp-2 text-xs leading-tight text-gray-100">{c.ru ?? c.name}</p>
          {c.ru && <p className="truncate text-[10px] text-gray-500">{c.name}</p>}
        </div>
      ))}
    </div>
  );
}

function SimilarBooks({ id }: { id: number }) {
  const { data, error, isLoading } = useQuery({ queryKey: ["book-similar", id], queryFn: () => api<{ books: BookLite[] }>(`/api/books/${id}/similar`), staleTime: 3600_000 });
  if (error) return <ErrorBox error={error} />;
  if (isLoading) return <Skel className="h-60 w-full" />;
  if (!data?.books.length) return <p className="text-sm text-gray-500">Похожих книг читатели AniList пока не предложили.</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">По рекомендациям читателей AniList</p>
      <Grid books={data.books} />
    </div>
  );
}

/** Строка издания: «Русский — 138 гл. (до 9-138), нет на русском: 1–5». */
function EditionLine({ e, multi }: { e: EditionSummary; multi: boolean }) {
  return (
    <div className="space-y-0.5">
      {multi && <p className="text-xs uppercase tracking-wide text-gray-500">{EDITION_LABELS[e.edition]}</p>}
      {e.langs.map((l) => (
        <p key={l.lang}>
          <span className="text-gray-400">{LANG_LABELS[l.lang] ?? l.lang}: </span>
          <span className="text-gray-100">{l.count} гл.</span>
          {l.last && <span className="text-gray-500"> · до {l.last}</span>}
          {l.teams.some((t) => t.team) && <span className="text-gray-500"> · {l.teams.slice(0, 3).map((t) => `${t.team ?? providerName(t.provider)} (${t.count})`).join(", ")}{l.teams.length > 3 ? ` и ещё ${l.teams.length - 3}` : ""}</span>}
        </p>
      ))}
      {e.missingRu.length > 0 && (
        <p><span className="text-warning-300">Нет на русском: </span><span className="text-gray-300">{e.missingRu.slice(0, 6).join(", ")}{e.missingRu.length > 6 ? "…" : ""}</span></p>
      )}
    </div>
  );
}

const PAGE = 100;

function ChapterList({ bookId, ed, pref, read }: { bookId: number; ed: EditionSummary; pref: { provider?: string; team?: string | null }; read: Map<string, boolean> }) {
  const [desc, setDesc] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const list = desc ? [...ed.chapters].reverse() : ed.chapters;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span>{ed.chapters.length} глав</span>
        <button onClick={() => setDesc(!desc)} className="hover:text-gray-200">{desc ? "Сначала первые" : "Сначала новые"}</button>
      </div>
      <div className="divide-y divide-gray-800 rounded-xl bg-gray-800/40 ring-1 ring-gray-700">
        {list.slice(0, shown).map((c) => {
          const t = pickTranslation(c, pref);
          const done = read.get(c.key);
          return (
            <div key={c.key} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={cx("w-5 shrink-0", done ? "text-positive-300" : "text-transparent")}><CheckIcon className="h-4 w-4" /></span>
              {t ? (
                <Link href={readHref(bookId, ed.edition, c, t)} className="min-w-0 flex-1 truncate hover:text-accent-200">
                  <span className="text-gray-100">{chapterName(c, ed.edition)}</span>
                  {c.title && <span className="text-gray-400"> · {c.title}</span>}
                </Link>
              ) : <span className="min-w-0 flex-1 truncate text-gray-500">{chapterName(c, ed.edition)}</span>}
              <span className="flex shrink-0 gap-1">
                {Object.keys(c.langs).map((l) => (
                  <span key={l} title={c.langs[l].map((x) => translationLabel(x, providerName)).join("\n")}
                    className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", l === "ru" ? "tone-positive soft" : l === "orig" ? "tone-neutral soft" : l === "ai" ? "tone-special soft" : "tone-info soft")}>
                    {l === "orig" ? "ориг" : l === "ai" ? "ИИ" : l}{c.langs[l].length > 1 ? ` ×${c.langs[l].length}` : ""}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {list.length > shown && <Button size="sm" onClick={() => setShown(shown + PAGE * 3)}>Показать ещё ({list.length - shown})</Button>}
    </div>
  );
}

/** Список чтения: статус и сколько прочитано. */
function ReadControl({ bookId, entry }: { bookId: number; entry: { status: string; chapters: number } | null }) {
  const qc = useQueryClient();
  const set = async (status: string | null) => {
    await api(`/api/books/${bookId}/entry`, { method: "PUT", json: { status } });
    await qc.invalidateQueries({ queryKey: ["book-progress", bookId] });
    await qc.invalidateQueries({ queryKey: ["read-list"] });
  };
  return (
    <select value={entry?.status ?? ""} onChange={(e) => void set(e.target.value || null)}
      className="h-9 rounded-lg border border-gray-600 bg-gray-800 px-2 text-sm focus:border-accent-500 focus:outline-none">
      <option value="">{entry ? "Убрать из списка" : "Добавить в список"}</option>
      {Object.entries(READ_LABELS).map(([k, v]) => <option key={k} value={k}>{v}{entry?.status === k && entry.chapters ? ` · ${entry.chapters} гл.` : ""}</option>)}
    </select>
  );
}

/** Уведомления о новых главах (книга в «Читаю»); выключатель общий с сериями — `/api/anime/<id>/mute`. */
function ChapterAlerts({ bookId, reading }: { bookId: number; reading: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["mute", bookId], queryFn: () => api<{ muted: boolean }>(`/api/anime/${bookId}/mute`), enabled: reading });
  if (!reading || !data) return null;
  const toggle = async () => {
    qc.setQueryData(["mute", bookId], { muted: !data.muted });
    await api(`/api/anime/${bookId}/mute`, { method: "POST", json: { muted: !data.muted } });
  };
  return (
    <Button onClick={toggle} variant={data.muted ? "ghost" : "default"}
      title={data.muted ? "Включить уведомления о новых главах" : "Уведомляю о новых главах на русском, а если на русском нет — на английском и в оригинале. Нажмите, чтобы выключить"}>
      {data.muted ? <BellSlashIcon className="h-4 w-4 text-gray-500" /> : <BellAlertIcon className="h-4 w-4 text-accent-300" />}
      {data.muted ? "Без уведомлений" : "О новых главах"}
    </Button>
  );
}

/** Провайдеры: где нашлась книга; не та — скрыть, нет — найти вручную. */
function Providers({ page, onChange }: { page: BookPage; onChange: () => void }) {
  const [search, setSearch] = useState<string | null>(null);
  const kinds = page.book.kind === "novel" ? ["ranobelib", "syosetu"] : ["mangalib", "mangadex"];
  const refresh = async () => { await api(`/api/books/${page.book.id}/sync`, { method: "POST" }); onChange(); };
  return (
    <section className="space-y-2 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Провайдеры</h2>
        <button onClick={() => void refresh()} title="Искать заново и обновить главы" className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"><ArrowPathIcon className="h-4 w-4" /></button>
      </div>
      {kinds.map((p) => {
        const links = page.links.filter((l) => l.provider === p);
        const found = links.filter((l) => l.ref);
        return (
          <div key={p} className="space-y-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-300">{providerName(p)}</span>
              <button onClick={() => setSearch(p)} className="flex items-center gap-1 text-xs text-accent-300 hover:text-accent-200"><MagnifyingGlassIcon className="h-3.5 w-3.5" />{found.length ? "другая" : "найти"}</button>
            </div>
            {found.map((l) => (
              <div key={l.ref} className="flex items-center gap-2 text-xs">
                <a href={l.url ?? "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-gray-400 hover:text-gray-200" title={l.title ?? l.ref}>
                  {l.title ?? l.ref}{l.edition !== "main" ? ` · ${EDITION_LABELS[l.edition].toLowerCase()}` : ""}{l.how === "manual" ? " · вручную" : ""}
                </a>
                <button onClick={async () => { await api(`/api/books/${page.book.id}/links`, { method: "POST", json: { provider: p, ref: l.ref, action: "hide" } }); onChange(); }}
                  className="shrink-0 text-gray-500 hover:text-negative-300" title="Это другая книга">не та</button>
              </div>
            ))}
            {!found.length && links.length > 0 && <p className="text-xs text-gray-500">не нашлось</p>}
          </div>
        );
      })}
      {search && <ProviderSearch bookId={page.book.id} provider={search} onClose={() => setSearch(null)} onLinked={() => { setSearch(null); onChange(); }} />}
    </section>
  );
}

function ProviderSearch({ bookId, provider, onClose, onLinked }: { bookId: number; provider: string; onClose: () => void; onLinked: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<BookHit[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const run = async (query: string) => {
    setHits(null); setErr(null);
    try { setHits((await api<{ hits: BookHit[] }>(`/api/books/${bookId}/search?provider=${provider}${query ? `&q=${encodeURIComponent(query)}` : ""}`)).hits); }
    catch (e) { setErr(e); setHits([]); }
  };
  useEffect(() => { void run(""); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open onClose={onClose} title={`Найти на ${providerName(provider)}`} wide>
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Название (пусто — по названиям книги)"
          className="min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-900 px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none" />
        <Button type="submit">Искать</Button>
      </form>
      {err ? <ErrorBox error={err} /> : null}
      {hits === null ? <p className="flex items-center gap-2 text-sm text-gray-400"><Spinner className="h-4 w-4" />Ищу…</p> : !hits.length ? <p className="text-sm text-gray-500">Ничего</p> : (
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {hits.map((h) => (
            <div key={h.ref} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-gray-800">
              {h.cover ? <Img src={h.cover} size="thumb" className="h-12 w-8 shrink-0 rounded object-cover" /> : <div className="h-12 w-8 shrink-0 rounded bg-gray-800" />}
              <div className="min-w-0 flex-1 text-sm">
                <a href={h.url} target="_blank" rel="noreferrer" className="block truncate text-gray-100 hover:text-accent-200">{h.title}</a>
                <p className="truncate text-xs text-gray-500">{[h.year, h.note, h.score >= 1 ? "совпадает" : null].filter(Boolean).join(" · ")}</p>
              </div>
              <Button size="sm" onClick={async () => { await api(`/api/books/${bookId}/links`, { method: "POST", json: { provider, ref: h.ref, action: "link", title: h.title, edition: h.edition } }); onLinked(); }}>Это она</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const REL_LABELS: Record<string, string> = {
  ADAPTATION: "Экранизация", SOURCE: "Первоисточник", SEQUEL: "Продолжение", PREQUEL: "Предыстория", SIDE_STORY: "Побочная история",
  SPIN_OFF: "Спин-офф", ALTERNATIVE: "Другая версия", PARENT: "Основная история", SUMMARY: "Пересказ", OTHER: "Другое", CHARACTER: "Персонажи",
};

function Related({ page }: { page: BookPage }) {
  const rel = page.book.relations.filter((r) => r.relationType !== "CHARACTER");
  if (!rel.length) return null;
  return (
    <section className="space-y-2 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <h2 className="font-semibold">Связанное</h2>
      {rel.slice(0, 12).map((r) => (
        <Link key={r.id} href={r.type === "ANIME" ? `/anime/${r.id}` : `/manga/${r.id}`} className="flex items-center gap-2 rounded-md p-1 hover:bg-gray-700/60">
          {r.cover ? <Img src={r.cover} size="thumb" className="h-12 w-8 shrink-0 rounded object-cover" /> : <div className="h-12 w-8 shrink-0 rounded bg-gray-800" />}
          <span className="min-w-0 text-sm">
            <span className="block truncate text-gray-100">{r.title}</span>
            <span className="block text-xs text-gray-500">{REL_LABELS[r.relationType] ?? r.relationType} · {r.type === "ANIME" ? "аниме" : r.format === "NOVEL" ? "ранобэ" : "манга"}{r.year ? ` · ${r.year}` : ""}</span>
          </span>
        </Link>
      ))}
    </section>
  );
}
