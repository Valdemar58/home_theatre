"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { BookLite, BookRelation } from "@/lib/books";
import { api } from "@/lib/client";
import { useBookKind } from "../Mode";
import { EmptyState, ErrorBox, Skel, Spinner } from "../ui";
import { BookCard } from "./BooksHome";

// «Для тебя» в режимах книг (TASKS 5.10): что советуют читатели книг, которые мне понравились, — с «потому что»,
// и первоисточники любимых аниме.

type Data = {
  picks: { book: BookLite; score: number; because: { id: number; title: string }[] }[];
  fromAnime: (BookRelation & { ru: string | null; anime: number })[];
  seeds: number;
  partial: boolean;
};

const relLite = (b: Data["fromAnime"][number]): BookLite => ({
  id: b.id, idMal: null, format: b.format, kind: b.format === "NOVEL" ? "novel" : "manga", status: b.status, chapters: null, volumes: null,
  countryOfOrigin: null, isAdult: false, title: { romaji: b.title, english: null, native: null, ru: b.ru }, coverImage: { large: b.cover, color: null }, year: b.year, averageScore: null,
});

export function BookForYou() {
  const kind = useBookKind();
  const { data, error, isLoading } = useQuery({
    queryKey: ["book-for-you", kind], queryFn: () => api<Data>(`/api/books/for-you?kind=${kind}`),
    refetchInterval: (q) => (q.state.data?.partial ? 10_000 : false),
  });
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="mx-auto max-w-6xl space-y-4"><Skel className="h-8 w-60" /><Skel className="h-80 w-full" /></div>;
  const what = kind === "novel" ? "ранобэ" : "манга";
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Для тебя <span className="text-lg font-normal text-gray-500">{what}</span></h1>
        <p className="text-sm text-gray-400">Что советуют читатели книг, которые вам понравились (оценка 6+ или прочитано), и первоисточники любимых аниме.</p>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">Советуют читатели {data.partial && <Spinner className="h-4 w-4" />}</h2>
        {!data.seeds ? (
          <EmptyState title="Пока не из чего советовать">Оцените или дочитайте несколько книг — подборка соберётся из рекомендаций к ним.</EmptyState>
        ) : !data.picks.length ? (
          <p className="text-sm text-gray-500">{data.partial ? "Собираю рекомендации к вашим книгам…" : "Рекомендаций пока нет."}</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {data.picks.map((p) => (
              <div key={p.book.id} className="space-y-1">
                <BookCard book={p.book} />
                <p className="line-clamp-2 text-xs text-gray-500">
                  как {p.because.map((b, i) => <span key={b.id}>{i ? ", " : ""}<Link href={`/manga/${b.id}`} className="text-gray-400 hover:text-accent-200">«{b.title}»</Link></span>)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {data.fromAnime.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold">По любимым аниме <span className="text-sm font-normal text-gray-500">первоисточники и адаптации</span></h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {data.fromAnime.map((b) => <BookCard key={b.id} book={relLite(b)} />)}
          </div>
        </section>
      )}
    </div>
  );
}
