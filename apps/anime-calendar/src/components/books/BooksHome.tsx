"use client";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { KIND_LABELS, READ_LABELS, type BookLite } from "@/lib/books";
import { api, useReadList, type ReadListItem } from "@/lib/client";
import { Img } from "../Img";
import { bookMode, useDeclareMode } from "../Mode";
import { Button, EmptyState, ErrorBox, Skel, Spinner } from "../ui";

// Раздел книг: поиск (по-русски — через Shikimori), свой список чтения по статусам, импорт закладок Lib. Манга или
// ранобэ — по режиму в шапке (?kind=).

type Kind = "manga" | "novel";

const bookName = (b: BookLite) => b.title.ru || b.title.romaji || b.title.english || String(b.id);

export function BooksHome() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const param = useSearchParams().get("kind");
  const [stored, setStored] = useState<Kind>("manga");
  useEffect(() => setStored(bookMode() === "novel" ? "novel" : "manga"), []);
  const kind: Kind = param === "novel" || param === "manga" ? param : stored;
  useDeclareMode(kind);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["book-search", query, kind], enabled: query.length >= 2,
    queryFn: () => api<{ books: BookLite[] }>(`/api/books/search?q=${encodeURIComponent(query)}&kind=${kind}`),
  });
  const { data: list, isLoading } = useReadList();
  const mine = (list?.items ?? []).filter((i) => (i.book.kind === "novel") === (kind === "novel"));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{kind === "novel" ? "Ранобэ" : "Манга"}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg bg-gray-800/70 px-3 ring-1 ring-gray-700 focus-within:ring-accent-500">
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

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Мой список</h2>
          <LibImport />
        </div>
        {isLoading ? <Skel className="h-40 w-full" /> : !mine.length ? (
          <EmptyState title="Список чтения пуст">Найдите книгу выше и добавьте её — или просто начните читать: прочитанная глава сама добавит книгу в «Читаю».</EmptyState>
        ) : Object.keys(READ_LABELS).map((status) => {
          const items = mine.filter((i) => i.status === status);
          return items.length ? <ListGroup key={status} label={READ_LABELS[status]} items={items} /> : null;
        })}
      </section>
    </div>
  );
}

function Grid({ books }: { books: BookLite[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {books.map((b) => <BookCard key={b.id} book={b} />)}
    </div>
  );
}

function BookCard({ book, extra }: { book: BookLite; extra?: string }) {
  return (
    <Link href={`/manga/${book.id}`} className="group space-y-1.5">
      <div className="aspect-[2/3] overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700">
        {book.coverImage.large && <Img src={book.coverImage.large} size="card" className="h-full w-full object-cover transition group-hover:scale-105" />}
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
