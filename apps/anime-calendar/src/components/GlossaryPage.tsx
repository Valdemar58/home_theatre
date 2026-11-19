"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client";
import { Breadcrumbs } from "./Breadcrumbs";
import { GlossaryEditor } from "./GlossaryEditor";

// Страница глоссария франшизы: из франшизы аниме (/franchise/<id>/glossary) или из книги (/manga/<id>/glossary) —
// у книги с экранизацией глоссарий общий с аниме.

export function GlossaryPage({ anime, book }: { anime?: number; book?: number }) {
  const qs = anime ? `anime=${anime}` : `book=${book}`;
  const { data } = useQuery({ queryKey: ["glossary", qs], queryFn: () => api<{ title: string | null }>(`/api/glossary?${qs}`) });
  const back = anime ? { label: "Франшиза", href: `/franchise/${anime}` } : { label: "Книга", href: `/manga/${book}` };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Breadcrumbs items={[back, { label: "Глоссарий" }]} />
      <div>
        <h1 className="text-2xl font-bold">Глоссарий{data?.title ? ` · ${data.title}` : ""}</h1>
        <p className="mt-1 text-sm text-gray-400">Как по-русски пишутся имена, места и термины франшизы. По нему переводятся пересказы, надписи, кадры и главы книг — одинаково везде.</p>
      </div>
      <GlossaryEditor anime={anime} book={book} />
    </div>
  );
}
