"use client";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { KIND_LABELS, READ_LABELS, type BookLite } from "@/lib/books";
import { api, useReadList, type ReadListItem } from "@/lib/client";
import { Img } from "../Img";
import { Chip, EmptyState, ErrorBox, Skel, Spinner } from "../ui";

// Раздел «Читать»: поиск книг (по-русски — через Shikimori) и свой список чтения по статусам.

type Kind = "all" | "manga" | "novel";
const KINDS: { id: Kind; label: string }[] = [{ id: "all", label: "Всё" }, { id: "novel", label: "Ранобэ" }, { id: "manga", label: "Манга и манхва" }];

const bookName = (b: BookLite) => b.title.ru || b.title.romaji || b.title.english || String(b.id);

export function BooksHome() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ["book-search", query, kind], enabled: query.length >= 2,
    queryFn: () => api<{ books: BookLite[] }>(`/api/books/search?q=${encodeURIComponent(query)}&kind=${kind}`),
  });
  const { data: list, isLoading } = useReadList();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Читать</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg bg-gray-800/70 px-3 ring-1 ring-gray-700 focus-within:ring-accent-500">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Манга, манхва, ранобэ — по-русски или в оригинале"
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-gray-500" />
          </label>
          {KINDS.map((k) => <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</Chip>)}
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
        <h2 className="text-lg font-bold">Мой список</h2>
        {isLoading ? <Skel className="h-40 w-full" /> : !list?.items.length ? (
          <EmptyState title="Список чтения пуст">Найдите книгу выше и добавьте её — или просто начните читать: прочитанная глава сама добавит книгу в «Читаю».</EmptyState>
        ) : Object.keys(READ_LABELS).map((status) => {
          const items = list.items.filter((i) => i.status === status);
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
