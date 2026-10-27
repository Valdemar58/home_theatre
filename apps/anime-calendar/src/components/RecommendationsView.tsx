"use client";
import { ArrowPathIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/20/solid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { FORMAT_LABELS, GENRE_LABELS, label } from "@/lib/labels";
import { formatDate } from "@/lib/time";
import type { RecoResponse, Recommendation } from "@/server/reco/engine";
import type { QueueStatus } from "@/server/reco/profile";
import { Badge, Button, cx, EmptyState, ErrorBox, matchTone, Skel, SkelText, TONE_CLASS } from "./ui";
import { useHoverCard } from "./HoverCard";
import { TagList } from "./TagList";
import { Img } from "./Img";
import { FriendPicks } from "./FriendPicks";

const FILTERS: [string, string, (r: Recommendation) => boolean][] = [
  ["all", "Все", () => true],
  ["tv", "Сериалы", (r) => r.format === "TV" || r.format === "ONA"],
  ["short", "Короткие (до 13 серий)", (r) => (r.episodes ?? 99) <= 13 && r.format !== "MOVIE"],
  ["movie", "Фильмы", (r) => r.format === "MOVIE"],
  ["planned", "Из запланированного", (r) => r.planned],
];

function MatchBadge({ value }: { value: number }) {
  return <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs font-bold soft", TONE_CLASS[matchTone(value)])} title="Насколько понравится: лучше, чем N% популярных аниме">{value}%</span>;
}

const votesWord = (n: number) => {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? "голос" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "голоса" : "голосов";
};

/** «С „Реинкарнацией“: Isekai, Magic · Фэнтези · 42 голоса зрителей» — что общего с основанием. */
function Common({ b }: { b: Recommendation["basedOn"][number] }) {
  const parts: React.ReactNode[] = [
    b.tags?.length ? <TagList key="t" names={b.tags} /> : null,
    b.genres?.length ? b.genres.map((g) => GENRE_LABELS[g] ?? g).join(", ") : null,
    b.votes ? `${b.votes} ${votesWord(b.votes)} зрителей «похоже»` : null,
  ].filter(Boolean);
  return (
    <li className="text-xs leading-snug">
      <Link href={`/anime/${b.id}`} className="block truncate text-gray-200 hover:text-indigo-300" title={b.title}>{b.title}</Link>
      {parts.length > 0 && <p className="line-clamp-1 text-gray-400">{parts.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>)}</p>}
    </li>
  );
}

export function RecCard({ r }: { r: Recommendation }) {
  const hover = useHoverCard(r.id, r.reason ? { reason: r.reason } : undefined);
  return (
    <div {...hover} className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700 transition hover:ring-gray-500">
      {/* Постер — во всю высоту карточки (не меньше 2:3), текст рядом не «перерастает» его */}
      <Link href={`/anime/${r.id}`} className="relative min-h-52 w-36 shrink-0 self-stretch overflow-hidden rounded-lg ring-1 ring-gray-700"
        style={{ backgroundColor: r.color ?? undefined }}>
        {r.cover && <Img src={r.cover} size="card" className="absolute inset-0 h-full w-full object-cover" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/anime/${r.id}`} className="line-clamp-2 font-semibold leading-snug hover:text-indigo-300">{r.titleRu ?? r.title}</Link>
          <MatchBadge value={r.match} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
          <span>{label(FORMAT_LABELS, r.format)}</span>
          {r.year && <span>· {r.year}</span>}
          {r.episodes && <span>· {r.episodes} эп.</span>}
          {r.score && <span className="inline-flex items-center gap-0.5">· <StarIcon className="h-3 w-3 text-yellow-400" />{r.score.toFixed(1)}</span>}
          {r.planned && <Badge tone="accent">в планах</Badge>}
        </div>
        {r.reason && <p className="line-clamp-2 text-sm leading-snug text-gray-200" title={r.reason}>{r.reason}</p>}
        {r.basedOn.length > 0 ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Общее с вашими</p>
            <ul className="space-y-1.5">{r.basedOn.slice(0, 2).map((b) => <Common key={b.id} b={b} />)}</ul>
          </div>
        ) : r.likedTags?.length ? (
          <p className="text-xs text-gray-400"><span className="text-gray-500">Ваши любимые темы:</span> <TagList names={r.likedTags} /></p>
        ) : (
          <p className="text-xs text-gray-500">Близко к вашему вкусу по содержанию</p>
        )}
      </div>
    </div>
  );
}

export function RecommendationsView() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ["recommendations"],
    queryFn: () => api<RecoResponse>("/api/recommendations"),
    staleTime: 10 * 60_000,
  });
  const { data: status } = useQuery({
    queryKey: ["reco-status"],
    queryFn: () => api<QueueStatus>("/api/reco/status"),
    refetchInterval: 15_000,
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(["recommendations"], await api<RecoResponse>("/api/recommendations?refresh=1"));
    } finally {
      setRefreshing(false);
    }
  };

  const items = (data?.items ?? []).filter(FILTERS.find((f) => f[0] === filter)![2]);
  const filterBar = (aside: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {FILTERS.map(([key, text]) => (
        <button key={key} onClick={() => setFilter(key)}
          className={cx("rounded-full border px-3 py-1 text-xs font-medium transition",
            filter === key ? "border-indigo-500 bg-indigo-600 text-white" : "border-gray-700 text-gray-300 hover:border-gray-500")}>
          {text}
        </button>
      ))}
      {aside}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl"><SparklesIcon className="h-7 w-7 text-indigo-400" /> Для тебя</h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-400">
          {status && (
            <span title={`Модель ${status.model}`}>
              {status.llm ? "LLM подключена" : "LLM недоступна — рекомендации без объяснений"}
              {status.pending > 0 && ` · анализ в очереди: ${status.pending}`}
            </span>
          )}
          <Button size="sm" onClick={refresh} disabled={refreshing}>
            <ArrowPathIcon className={cx("h-4 w-4", refreshing && "animate-spin")} /> {refreshing ? "Считаю…" : "Пересчитать"}
          </Button>
        </div>
      </div>

      {error ? <ErrorBox error={error} /> : null}
      {/* Пока считается: фильтры и «советуют друзья» уже живые, портрет и карточки — заглушками */}
      {isLoading ? (
        <>
          <section aria-busy className="rounded-xl bg-gray-800/50 p-5 ring-1 ring-gray-700">
            <p className="mb-3 text-sm text-gray-400">Изучаю твои списки и подбираю тайтлы… (первый раз до пары минут)</p>
            <SkelText lines={3} />
            <div className="mt-3 flex flex-wrap gap-1.5">{[0, 1, 2, 3].map((i) => <Skel key={i} className="h-5 w-20 rounded-full" />)}</div>
          </section>
          <FriendPicks />
          {filterBar(<span className="ml-auto inline-flex"><Skel className="h-3 w-56" /></span>)}
          <div aria-busy className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
                <Skel className="min-h-52 w-36 shrink-0 self-stretch rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-start justify-between gap-2"><Skel className="h-5 w-3/4" /><Skel className="h-5 w-10 rounded-full" /></div>
                  <Skel className="h-3 w-1/2" />
                  <SkelText lines={2} />
                  <Skel className="h-3 w-28" />
                  <Skel className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : !data ? null : (
        <>
          {data.portrait ? (
            <section className="rounded-xl bg-linear-to-br from-indigo-600/15 to-purple-600/10 p-5 ring-1 ring-indigo-500/30">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-indigo-300">Твой вкус глазами модели</h2>
              {data.portraitStale && data.portraitAt && (
                <p className="mb-2 text-xs text-gray-400">Портрет от {formatDate(data.portraitAt)} — по прошлой версии списка: ИИ сейчас недоступен.</p>
              )}
              <p className="leading-relaxed text-gray-200">{data.portrait.portrait_ru}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {data.portrait.likes.map((l) => <Badge key={l} tone="positive">{l}</Badge>)}
                {data.portrait.dislikes.map((l) => <Badge key={l} tone="negative">{l}</Badge>)}
                {data.portrait.ironic_enjoyment && <Badge tone="special">любит «так плохо, что смешно»</Badge>}
                {data.portrait.voice_matters && <Badge tone="warning">озвучка важна{data.portrait.preferred_voices.length ? `: ${data.portrait.preferred_voices.join(", ")}` : ""}</Badge>}
              </div>
            </section>
          ) : (
            <div className="rounded-xl bg-gray-800/50 p-4 text-sm text-gray-400 ring-1 ring-gray-700">
              {data.stats.rated < 2
                ? "Оцени хотя бы несколько тайтлов (звёзды и теги на странице аниме) — тогда появится портрет вкуса и точнее рекомендации."
                : data.stats.llm ? "Портрет вкуса строится…" : "Портрет вкуса появится, когда заработает ИИ: локальная модель (Ollama) или внешний API."}
            </div>
          )}

          <FriendPicks />

          {filterBar(
            <span className="ml-auto text-xs text-gray-500">
              учтено тайтлов: {data.stats.rated} · проанализировано: {data.stats.analyzed}/{data.stats.profiled}
            </span>,
          )}

          {items.length === 0 ? (
            <EmptyState title="Пока нечего предложить">
              Добавь в списки и оцени несколько тайтлов — рекомендации строятся от того, что тебе понравилось.
            </EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {items.map((r) => <RecCard key={r.id} r={r} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
