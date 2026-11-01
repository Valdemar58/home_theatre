"use client";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { KIND_LABELS, READ_LABELS, type BookLite, type BookRelation } from "@/lib/books";
import { GENRE_LABELS } from "@/lib/labels";
import { api, useReadList, type ReadListItem } from "@/lib/client";
import { Img } from "../Img";
import { useBookKind } from "../Mode";
import { Button, Chip, EmptyState, ErrorBox, Skel, Spinner } from "../ui";

// Раздел книг: каталог с поиском (по-русски — через Shikimori) и мои списки по статусам с импортом закладок Lib.
// Манга или ранобэ — по режиму в шапке (?kind=).

type Kind = "manga" | "novel";

const bookName = (b: BookLite) => b.title.ru || b.title.romaji || b.title.english || String(b.id);

export function BooksHome() {
  // Полный поиск из строки в шапке приходит как ?q=
  const initial = useSearchParams().get("q") ?? "";
  const [q, setQ] = useState(initial);
  useEffect(() => setQ(initial), [initial]);
  const [query, setQuery] = useState("");
  const kind: Kind = useBookKind();
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["book-search", query, kind], enabled: query.length >= 2,
    queryFn: () => api<{ books: BookLite[] }>(`/api/books/search?q=${encodeURIComponent(query)}&kind=${kind}`),
  });
  const { data: list } = useReadList();
  const reading = (list?.items ?? []).filter((i) => (i.book.kind === "novel") === (kind === "novel") && (i.status === "watching" || i.status === "rewatching"));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{kind === "novel" ? "Ранобэ" : "Манга"}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 w-full flex-1 sm:min-w-64 items-center gap-2 rounded-lg bg-gray-800/70 px-3 ring-1 ring-gray-700 focus-within:ring-accent-500">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "novel" ? "Ранобэ — по-русски или в оригинале" : "Манга, манхва, маньхуа — по-русски или в оригинале"}
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-gray-500" />
          </label>
        </div>
      </div>

      {query.length >= 2 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 font-semibold">Найдено {search.isFetching && <Spinner className="h-4 w-4" />}</h2>
          {search.error ? <ErrorBox error={search.error} /> : null}
          {search.data && !search.data.books.length && <p className="text-sm text-gray-500">Ничего не нашлось</p>}
          <Grid books={search.data?.books ?? []} />
        </section>
      )}

      {query.length < 2 && reading.length > 0 && (
        <Row title="Читаю сейчас">
          {reading.slice(0, 12).map((i) => <div key={i.bookId} className="w-32 shrink-0"><BookCard book={i.book} extra={i.chapters ? `${i.chapters} гл.` : undefined} /></div>)}
        </Row>
      )}
      {query.length < 2 && <Catalog kind={kind} />}
    </div>
  );
}

/** Мои списки в режиме книг: по статусам, импорт закладок Lib. */
export function BookList() {
  const kind: Kind = useBookKind();
  const { data: list, isLoading } = useReadList();
  const mine = (list?.items ?? []).filter((i) => (i.book.kind === "novel") === (kind === "novel"));
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Мои списки <span className="text-lg font-normal text-gray-500">{kind === "novel" ? "ранобэ" : "манга"}</span></h1>
        <LibImport />
      </div>
      {isLoading ? <Skel className="h-40 w-full" /> : !mine.length ? (
        <EmptyState title="Список чтения пуст">Найдите книгу в каталоге и добавьте её — или просто начните читать: прочитанная глава сама добавит книгу в «Читаю».</EmptyState>
      ) : Object.keys(READ_LABELS).map((status) => {
        const items = mine.filter((i) => i.status === status);
        return items.length ? <ListGroup key={status} label={READ_LABELS[status]} items={items} /> : null;
      })}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-bold">{title} {hint && <span className="text-sm font-normal text-gray-500">{hint}</span>}</h2>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">{children}</div>
    </section>
  );
}

type Sort = "popular" | "score" | "trending" | "new";
const SORTS: { id: Sort; label: string }[] = [{ id: "popular", label: "Популярное" }, { id: "trending", label: "Сейчас читают" }, { id: "score", label: "По оценке" }, { id: "new", label: "Новое" }];
const SUBS = [{ id: "", label: "Все" }, { id: "manga", label: "Манга" }, { id: "manhwa", label: "Манхва" }, { id: "manhua", label: "Маньхуа" }, { id: "oneshot", label: "Ваншоты" }];
const STATUSES = [{ id: "", label: "Любой статус" }, { id: "RELEASING", label: "Выходит" }, { id: "FINISHED", label: "Завершена" }];
const GENRES = Object.keys(GENRE_LABELS).filter((g) => g !== "Hentai");

type BrowsePage = { books: BookLite[]; more: boolean; fromAnime: (BookRelation & { ru: string | null; anime: number })[] | null; ru: number[] };

/** Каталог книг: по аниме, которое смотрел, и вся база AniList с фильтрами. */
function Catalog({ kind }: { kind: Kind }) {
  const [sort, setSort] = useState<Sort>("popular");
  const [sub, setSub] = useState("");
  const [status, setStatus] = useState("");
  const [genres, setGenres] = useState<string[]>([]);
  const params = `kind=${kind}&sort=${sort}&sub=${kind === "manga" ? sub : ""}&status=${status}&genres=${encodeURIComponent(genres.join(","))}`;
  const q = useInfiniteQuery({
    queryKey: ["book-browse", params], initialPageParam: 1, staleTime: 600_000,
    queryFn: ({ pageParam }) => api<BrowsePage>(`/api/books/browse?${params}&page=${pageParam}`),
    getNextPageParam: (last, all) => (last.more ? all.length + 1 : undefined),
  });
  const fromAnime = q.data?.pages[0]?.fromAnime ?? [];
  const books = q.data?.pages.flatMap((p) => p.books) ?? [];
  const ru = new Set(q.data?.pages.flatMap((p) => p.ru) ?? []);
  const toggle = (g: string) => setGenres(genres.includes(g) ? genres.filter((x) => x !== g) : [...genres, g]);
  return (
    <>
      {fromAnime.length > 0 && (
        <Row title="По аниме, которое смотрел" hint="первоисточники и адаптации">
          {fromAnime.map((b) => (
            <div key={b.id} className="w-32 shrink-0">
              <BookCard book={{ id: b.id, idMal: null, format: b.format, kind: b.format === "NOVEL" ? "novel" : "manga", status: b.status, chapters: null, volumes: null, countryOfOrigin: null, isAdult: false,
                title: { romaji: b.title, english: null, native: null, ru: b.ru }, coverImage: { large: b.cover, color: null }, year: b.year, averageScore: null }} ru={ru.has(b.id)} />
            </div>
          ))}
        </Row>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Каталог</h2>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {SORTS.map((x) => <Chip key={x.id} active={sort === x.id} onClick={() => setSort(x.id)}>{x.label}</Chip>)}
            <span className="w-px bg-gray-700" />
            {kind === "manga" && SUBS.map((x) => <Chip key={x.id} active={sub === x.id} onClick={() => setSub(x.id)}>{x.label}</Chip>)}
            {kind === "manga" && <span className="w-px bg-gray-700" />}
            {STATUSES.map((x) => <Chip key={x.id} active={status === x.id} onClick={() => setStatus(x.id)}>{x.label}</Chip>)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {GENRES.map((g) => <Chip key={g} active={genres.includes(g)} onClick={() => toggle(g)}>{GENRE_LABELS[g]}</Chip>)}
          </div>
        </div>
        {q.error ? <ErrorBox error={q.error} /> : null}
        {q.isLoading ? <Skel className="h-80 w-full" /> : !books.length ? <p className="text-sm text-gray-500">Ничего не нашлось</p> : <Grid books={books} ru={ru} />}
        {q.hasNextPage && (
          <div className="flex justify-center">
            <Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? <Spinner className="h-4 w-4" /> : null}Показать ещё</Button>
          </div>
        )}
      </section>
    </>
  );
}

export function Grid({ books, ru }: { books: BookLite[]; ru?: Set<number> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {books.map((b) => <BookCard key={b.id} book={b} ru={ru?.has(b.id)} />)}
    </div>
  );
}

/** Карточка книги; ru — русский перевод уже известен (нашёлся у провайдеров). */
export function BookCard({ book, extra, ru }: { book: BookLite; extra?: string; ru?: boolean }) {
  return (
    <Link href={`/manga/${book.id}`} className="group space-y-1.5">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700">
        {book.coverImage.large && <Img src={book.coverImage.large} size="card" className="h-full w-full object-cover transition group-hover:scale-105" />}
        {ru && <span title="Есть главы на русском" className="absolute left-1.5 top-1.5 rounded px-1.5 text-[10px] font-semibold tone-positive solid">RU</span>}
      </div>
      <p className="line-clamp-2 text-sm text-gray-100 group-hover:text-accent-200">{bookName(book)}</p>
      <p className="text-xs text-gray-500">{[KIND_LABELS[book.kind], book.year, extra].filter(Boolean).join(" · ")}</p>
    </Link>
  );
}

function ListGroup({ label, items }: { label: string; items: ReadListItem[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-300">{label} <span className="text-gray-500">{items.length}</span></h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {items.map((i) => <BookCard key={i.bookId} book={i.book} extra={i.chapters ? `${i.chapters} гл.` : undefined} />)}
      </div>
    </div>
  );
}

type ImportState = {
  linked: boolean;
  progress: {
    stage: string; done: number; total: number; finishedAt?: number; error?: string;
    result?: { added: number; updated: number; same: number; skipped: number; removed: number; unmatched: { title: string; url: string; folder: string }[] };
  } | null;
};

/** Импорт закладок mangalib и ranobelib (профиль Lib — из карточки AniLib в Настройках). */
function LibImport() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["book-import"], queryFn: () => api<ImportState>("/api/books/import-lib"),
    refetchInterval: (q) => (q.state.data?.progress && !q.state.data.progress.finishedAt ? 1000 : false),
  });
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const p = data?.progress;
  const running = Boolean(p && !p.finishedAt);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) void qc.invalidateQueries({ queryKey: ["read-list"] });
    was.current = running;
  }, [running, qc]);
  if (!data) return null;
  if (!data.linked) return <Link href="/settings" className="text-xs text-gray-500 hover:text-gray-300">Импорт закладок Lib — подключите профиль AniLib в Настройках</Link>;
  const r = p?.result;
  return (
    <div className="flex flex-col items-end gap-1 text-sm">
      <Button size="sm" disabled={running} onClick={() => { setError(null); api("/api/books/import-lib", { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["book-import"] })).catch(setError); }}>
        {running ? <><Spinner className="h-4 w-4" />{p!.stage === "fetch" ? "Загружаю закладки" : `Сопоставляю ${p!.done} из ${p!.total}`}</> : "Импорт закладок MangaLib и RanobeLib"}
      </Button>
      {error ? <ErrorBox error={error} /> : null}
      {p?.error && <p className="text-xs text-negative-300">{p.error}</p>}
      {r && (
        <p className="text-xs text-gray-400">
          Добавлено {r.added}, обновлено {r.updated}, без изменений {r.same + r.removed}
          {r.skipped ? `, пропущено ${r.skipped} (папка без статуса)` : ""}
          {r.unmatched.length ? <> · <button className="underline decoration-dotted" onClick={() => setOpen(!open)}>не найдено {r.unmatched.length}</button></> : null}
        </p>
      )}
      {open && r && (
        <ul className="max-h-60 w-80 max-w-full overflow-y-auto rounded-lg bg-gray-900 p-2 text-xs ring-1 ring-gray-700">
          {r.unmatched.map((u) => (
            <li key={u.url} className="flex justify-between gap-2 py-0.5">
              <a href={u.url} target="_blank" rel="noreferrer" className="truncate text-gray-200 hover:underline">{u.title}</a>
              <span className="shrink-0 text-gray-500">{u.folder}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
