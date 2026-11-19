"use client";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useFranchise } from "@/lib/client";
import { displayTitle } from "@/lib/schedule";
import { Img } from "./Img";
import { Skel } from "./ui";

// Переход к франшизе со страницы тайтла (TASKS 5.10): мини-обложки форм, название, сколько в ней тайтлов.
// Тайтл без франшизы (он один) — чипа нет.

export function FranchiseChip({ id }: { id: number }) {
  const { data, isLoading } = useFranchise(id);
  if (isLoading) return <Skel className="h-9 w-64 rounded-full" />;
  if (!data) return null;
  const count = data.items.length + data.books.length;
  if (count < 2) return null;
  const covers = [
    data.books.find((b) => b.kind === "main" && b.book.kind === "novel")?.book.coverImage.large,
    data.books.find((b) => b.kind === "main" && b.book.kind !== "novel")?.book.coverImage.large,
    data.items.find((i) => i.kind === "main")?.media.coverImage.large,
  ].filter((c): c is string => Boolean(c));
  const name = displayTitle(data.title);
  return (
    <Link href={`/franchise/${data.root}`} aria-label={`Франшиза «${name}», ${count} тайтлов`}
      className="inline-flex max-w-full items-center gap-2.5 rounded-full py-1 pl-1.5 pr-3 tone-accent soft">
      {covers.length > 0 && (
        <span aria-hidden className="flex shrink-0">
          {covers.map((c, i) => <Img key={c} src={c} size="thumb" className={`h-7 w-5 rounded object-cover ring-2 ring-gray-900 ${i ? "-ml-2" : ""}`} />)}
        </span>
      )}
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-accent-300">Франшиза</span>
      <span className="min-w-0 truncate text-sm font-semibold text-accent-100">{name}</span>
      <span className="shrink-0 rounded-full bg-accent-500/25 px-2 text-xs text-accent-200">{count}</span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-accent-300" />
    </Link>
  );
}
