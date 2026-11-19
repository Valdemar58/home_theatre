"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { langGroup, READ_LABELS, type BookLite, type Edition } from "@/lib/books";
import { api } from "@/lib/client";
import { Img } from "../Img";
import { useBookKind } from "../Mode";
import { cx, EmptyState, ErrorBox, Skel } from "../ui";
import { providerName, readHref } from "./BookView";

// «Выход глав» — календарь режима книг (TASKS 5.10): что вышло за последние недели у книг из моего списка,
// по дням (в поясе устройства), одна глава во всех переводах — одной строкой; непрочитанное выделено.

type Item = {
  bookId: number; date: number; key: string; numText: string; vol: number | null; edition: Edition;
  langs: { lang: string; team: string | null; provider: string; cref: string }[]; unread: boolean;
};
type Data = { items: Item[]; books: Record<number, BookLite & { status: string }> };

const bookName = (b: BookLite) => b.title.ru || b.title.romaji || b.title.english || String(b.id);
const LANG_CHIP: Record<string, string> = { ru: "tone-positive", orig: "tone-neutral", ai: "tone-special" };

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

export function BookReleases() {
  const kind = useBookKind();
  const { data, error, isLoading } = useQuery({ queryKey: ["book-releases"], queryFn: () => api<Data>("/api/books/releases"), staleTime: 300_000 });
  if (error) return <ErrorBox error={error} />;
  const items = (data?.items ?? []).filter((i) => (data!.books[i.bookId]?.kind === "novel") === (kind === "novel"));
  // День → книга → главы
  const days = new Map<string, Map<number, Item[]>>();
  for (const it of items) {
    const day = new Date(it.date * 1000).toDateString();
    const books = days.get(day) ?? new Map<number, Item[]>();
    books.set(it.bookId, [...(books.get(it.bookId) ?? []), it]);
    days.set(day, books);
  }
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Выход глав <span className="text-lg font-normal text-gray-500">{kind === "novel" ? "ранобэ" : "манга"}</span></h1>
        <p className="text-sm text-gray-400">Новые главы книг из моего списка за последние полтора месяца — у всех провайдеров и на всех языках.</p>
      </div>
      {isLoading ? <Skel className="h-60 w-full" /> : !days.size ? (
        <EmptyState title="Новых глав нет">Здесь появятся главы книг из списков «Читаю», «В планах» и «Отложено», как только они выйдут у провайдеров.</EmptyState>
      ) : [...days].map(([day, books]) => (
        <section key={day} className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{dayLabel([...books.values()][0][0].date)}</h2>
          <div className="space-y-2">
            {[...books].map(([id, chs]) => <BookDay key={id} book={data!.books[id]} chapters={chs} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function BookDay({ book, chapters }: { book: BookLite & { status: string }; chapters: Item[] }) {
  const list = [...chapters].sort((a, b) => (a.vol ?? 0) - (b.vol ?? 0) || parseFloat(a.numText) - parseFloat(b.numText));
  return (
    <div className="flex gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <Link href={`/manga/${book.id}`} className="relative h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-gray-800">
        {book.coverImage.large && <Img src={book.coverImage.large} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link href={`/manga/${book.id}`} className="font-semibold hover:text-accent-200">{bookName(book)}</Link>
          {book.status !== "watching" && <span className="text-xs text-gray-500">{READ_LABELS[book.status]?.toLowerCase()}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {list.map((c) => {
            const t = c.langs.find((l) => l.lang === "ru") ?? c.langs[0];
            return (
              <Link key={c.key} href={readHref(book.id, c.edition, { key: c.key.split("|")[1] }, t)}
                title={c.langs.map((l) => `${l.team ?? providerName(l.provider)} (${l.lang})`).join("\n")}
                className={cx("flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm ring-1", c.unread ? "bg-gray-800 ring-gray-600" : "text-gray-500 ring-gray-800")}>
                {c.vol ? `т. ${c.vol} ` : ""}гл. {c.numText}
                {[...new Set(c.langs.map((l) => langGroup(l.lang)))].map((g) => (
                  <span key={g} className={cx("rounded px-1 text-[10px] font-medium uppercase soft", LANG_CHIP[g] ?? "tone-info")}>{g === "orig" ? "ориг" : g === "ai" ? "ИИ" : g}</span>
                ))}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
