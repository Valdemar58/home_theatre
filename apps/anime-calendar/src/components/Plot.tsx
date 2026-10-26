"use client";
import { BookOpenIcon, CheckIcon, DocumentTextIcon, EyeIcon, EyeSlashIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, useMe, usePlot } from "@/lib/client";
import { stateAt } from "@/lib/plot-deep";
import type { AnimeDetails, CorpusState, EpisodeInfo, EpisodeTexts, ListEntry, PlotInfo } from "@/lib/types";
import { formatDate, formatTime, relative } from "@/lib/time";
import { Img } from "./Img";
import { Badge, cx, Spinner } from "./ui";

// Сюжет на странице тайтла: описание (синопсис ИИ вместо заглушки), «Что было раньше», серии.

const clean = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");

/** Описание: у заглушки Shikimori («Второй сезон …») — синопсис, составленный ИИ. */
export function Description({ media }: { media: AnimeDetails }) {
  const { data: plot } = usePlot(media.id);
  const ai = plot?.stub && plot.synopsis;
  const text = ai ? plot.synopsis! : media.description ? clean(media.description) : null;
  if (!text && !plot?.pending) return null;
  return (
    <section>
      <h2 className="mb-3 text-xl font-bold">Описание</h2>
      {text && <p className="whitespace-pre-line leading-relaxed text-gray-300">{text}</p>}
      {ai && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500">
          {plot.synopsisBy === "ai" && <SparklesIcon className="h-3.5 w-3.5 shrink-0" />}
          В каталоге только «{clean(media.description ?? "").trim() || "описания нет"}» —{" "}
          {plot.synopsisBy === "tmdb" ? "описание сезона из TMDB" : "описание составлено локальной ИИ по AniList, TMDB и первым сериям"}
        </p>
      )}
      {plot?.pending && (
        <p className="mt-2 flex items-center gap-2 text-xs text-gray-500"><Spinner className="h-3.5 w-3.5" /> Составляю подробное описание…</p>
      )}
      {plot?.hasPrequels && <Recap id={media.id} plot={plot} />}
    </section>
  );
}

/** «Что было раньше»: пересказ предыдущих частей, составляется по кнопке и хранится. */
function Recap({ id, plot }: { id: number; plot: PlotInfo }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const make = useMutation({
    mutationFn: () => api<PlotInfo>(`/api/anime/${id}/plot`, { method: "POST" }),
    onSuccess: (p) => { qc.setQueryData(["plot", id], p); setOpen(true); },
  });
  const r = plot.recap;
  if (!r) return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-gray-800/40 px-4 py-3 ring-1 ring-gray-700">
      <BookOpenIcon className="h-5 w-5 shrink-0 text-gray-400" />
      <span className="mr-auto text-sm text-gray-300">Забыли, что было раньше? ИИ перескажет предыдущие части — без спойлеров этой.</span>
      <button onClick={() => make.mutate()} disabled={make.isPending} className="tone-accent soft rounded-lg px-3 py-1.5 text-sm font-medium">
        {make.isPending ? <span className="flex items-center gap-2"><Spinner className="h-4 w-4" /> Составляю — до пары минут…</span> : "Что было раньше"}
      </button>
      {make.error && <p className="w-full text-xs text-negative-300">{String((make.error as Error).message)}</p>}
    </div>
  );
  return (
    <div className="mt-4 rounded-xl bg-gray-800/40 ring-1 ring-gray-700">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <BookOpenIcon className="h-5 w-5 shrink-0 text-gray-400" />
        <span className="mr-auto font-semibold">Что было раньше</span>
        <span className="text-xs text-gray-500">{open ? "Свернуть" : "Спойлеры к предыдущим частям — показать"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-gray-700/60 px-4 py-4">
          <div className="flex flex-wrap gap-1.5">
            {r.prequels.map((p, i) => (
              <Link key={p.id} href={`/anime/${p.id}`}><Badge tone="neutral" className="transition hover:brightness-125">{i + 1}. {p.title}</Badge></Link>
            ))}
          </div>
          <p className="whitespace-pre-line leading-relaxed text-gray-300">{r.text}</p>
          {r.thin && (
            <p className="tone-warning soft rounded-lg px-3 py-2 text-xs">
              Описаний серий «{r.prequels.at(-1)?.title}» нигде нет — пересказ доходит только до её завязки.
            </p>
          )}
          {r.points.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wider text-gray-500">Важно помнить</p>
              <ul className="space-y-1 text-sm text-gray-300">
                {r.points.map((p, i) => <li key={i} className="flex gap-2"><span className="text-accent-300">•</span>{p}</li>)}
              </ul>
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-gray-500"><SparklesIcon className="h-3.5 w-3.5" /> Пересказ локальной ИИ по описаниям частей и серий — возможны неточности</p>
        </div>
      )}
    </div>
  );
}

type Row = { number: number; info: EpisodeInfo | null; airingAt: number | null };

const SPOILERS_KEY = "episodes-show-all";

/** Серии: кадр, название, дата, описание. Описания после вашей серии скрыты (спойлеры). */
export function Episodes({ media, entry, now }: { media: AnimeDetails; entry?: ListEntry; now: number }) {
  const { data: plot } = usePlot(media.id);
  const [showAll, setShowAll] = useState(false);
  const [spoilers, setSpoilers] = useState(false);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  useEffect(() => {
    try { setSpoilers(localStorage.getItem(SPOILERS_KEY) === "1"); } catch { /* без хранилища — по умолчанию скрыто */ }
  }, []);
  const toggleSpoilers = () => {
    setSpoilers((v) => {
      try { localStorage.setItem(SPOILERS_KEY, v ? "0" : "1"); } catch { /* не страшно */ }
      return !v;
    });
  };

  const eps = plot?.episodes ?? [];
  const airing = new Map(media.schedule.map((s) => [s.episode, s.airingAt]));
  const total = Math.max(eps.at(-1)?.number ?? 0, media.schedule.at(-1)?.episode ?? 0);
  if (!total) return null;
  const byNum = new Map(eps.map((e) => [e.number, e]));
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({ number: i + 1, info: byNum.get(i + 1) ?? null, airingAt: airing.get(i + 1) ?? null }));
  // Досмотрено: всё — у «Просмотрено», иначе по прогрессу
  const seen = entry?.status === "completed" ? total : entry?.episodes ?? 0;
  const aired = (r: Row) => (r.airingAt ? r.airingAt * 1000 <= now : r.info?.airDate ? Date.parse(r.info.airDate) <= now : true);
  // Окно по умолчанию: пара досмотренных и дальше; у выходящих — до ближайших анонсов
  const start = Math.max(0, Math.min(seen - 2, total - 10));
  const shown = showAll ? rows : rows.slice(start, start + 10);
  const upcoming = rows.find((r) => r.airingAt && r.airingAt * 1000 > now);
  // Краткое содержание серий по-русски из пересказа сезона ИИ (каждая — только по своей серии)
  const beats = plot?.season ? stateAt(plot.season.states, Infinity).beats : {};
  const hasText = eps.some((e) => e.overview) || Object.keys(beats).length > 0;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="mr-auto text-xl font-bold">Серии <span className="text-base font-normal text-gray-500">{total}</span></h2>
        {upcoming && <span className="text-sm text-accent-300">Следующая: {upcoming.number} {relative(upcoming.airingAt!, now)}</span>}
        {hasText && seen < total && (
          <button onClick={toggleSpoilers} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200">
            {spoilers ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            {spoilers ? "Скрывать описания дальше моей серии" : "Показать все описания"}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl ring-1 ring-gray-700">
        {shown.map((r) => {
          const past = aired(r);
          const watched = r.number <= seen;
          const isFinale = media.episodes === r.number;
          const hidden = !spoilers && !watched && !opened.has(r.number);
          const date = r.airingAt ? `${formatDate(r.airingAt)} ${formatTime(r.airingAt)}` : r.info?.airDate ? formatDate(Date.parse(r.info.airDate) / 1000) : null;
          return (
            <div key={r.number} className={cx("flex gap-3 border-b border-gray-700/60 px-3 py-3 last:border-0 sm:gap-4 sm:px-4",
              isFinale ? "bg-special-500/10" : past ? "bg-gray-900/40" : "bg-gray-800/40")}>
              {r.info?.still ? (
                <div className={cx("relative aspect-video shrink-0 self-start overflow-hidden rounded-lg bg-gray-800", hasText ? "w-28 sm:w-40" : "w-20 sm:w-24")}>
                  <Img src={r.info.still} size="thumb" className={cx("h-full w-full object-cover", hidden && "blur-sm brightness-75")} />
                  {watched && <span className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5"><CheckIcon className="h-3.5 w-3.5 text-positive-300" /></span>}
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className={cx("font-medium", !past && "text-gray-300", watched && !r.info?.still && "text-gray-500")}>
                    <span className="tabular-nums text-gray-500">{r.number}.</span> {r.info?.title ?? `Серия ${r.number}`}
                    {watched && !r.info?.still && <CheckIcon className="ml-1.5 inline h-4 w-4 text-positive-300" />}
                  </span>
                  {isFinale && <Badge tone="special">Финал</Badge>}
                  <span className={cx("ml-auto text-xs", past ? "text-gray-500" : "text-gray-300")}>
                    {date}{!past && r.airingAt && <span className="ml-2 text-accent-300">{relative(r.airingAt, now)}</span>}
                  </span>
                </div>
                {(beats[r.number] || r.info?.overview) && (hidden ? (
                  <button onClick={() => setOpened((s) => new Set(s).add(r.number))}
                    className="mt-1 block text-left text-sm text-gray-500 hover:text-gray-300" title="Описание может раскрыть сюжет">
                    <span className="select-none blur-[3px]">{(beats[r.number] ?? r.info!.overview!).slice(0, 120)}</span>
                    <span className="ml-1 whitespace-nowrap text-xs">— спойлер, показать</span>
                  </button>
                ) : beats[r.number] ? (
                  <Overview text={beats[r.number]} en={false} ai />
                ) : (
                  <Overview text={r.info!.overview!} en={r.info!.lang === "en"} />
                ))}
                {r.info?.detail && !hidden && <EpisodeDetail id={media.id} ep={r.number} detail={r.info.detail} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        {shown.length < rows.length && (
          <button onClick={() => setShowAll(true)} className="text-sm text-accent-300 hover:text-accent-200">Показать все {rows.length} серий</button>
        )}
        {plot?.source && <span className="ml-auto">{hasText ? "Названия и описания" : eps.some((e) => e.title) ? "Названия и кадры" : "Кадры"} — {plot.source}</span>}
      </div>
      {plot?.season && <SeasonRetelling season={plot.season} seen={spoilers ? Infinity : seen} total={total} />}
      <CorpusBar id={media.id} />
      <SdhBar id={media.id} />
    </section>
  );
}

const SOURCE_LABEL: Record<string, string> = { sdh: "Субтитры", "wiki-en": "Википедия", fandom: "Fandom", mal: "MyAnimeList", danime: "dアニメストア", tmdb: "TMDB" };
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

/** Подробный пересказ серии из корпуса: по кнопке, вкладки по источникам. */
function EpisodeDetail({ id, ep, detail }: { id: number; ep: number; detail: NonNullable<EpisodeInfo["detail"]> }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const { data: texts, isLoading } = useQuery({
    queryKey: ["episode-texts", id, ep], queryFn: () => api<EpisodeTexts>(`/api/anime/${id}/corpus?ep=${ep}`), enabled: open, staleTime: 3600_000,
  });
  const qc = useQueryClient();
  const [original, setOriginal] = useState(false);
  const translate = useMutation({
    mutationFn: (source: string) => api<NonNullable<EpisodeTexts[number]["translation"]>>(`/api/anime/${id}/corpus/translate`, { method: "POST", json: { ep, source } }),
    onSuccess: (tr, source) => {
      qc.setQueryData<EpisodeTexts>(["episode-texts", id, ep], (old) => old?.map((t) => (t.source === source ? { ...t, translation: tr } : t)));
      setOriginal(false);
    },
  });
  // Все хуки — выше: свёрнутое и раскрытое состояние должны вызывать их одинаково
  if (!open) return (
    <button onClick={() => setOpen(true)} className="mt-1 flex items-center gap-1.5 text-xs text-accent-300 hover:text-accent-200">
      <DocumentTextIcon className="h-3.5 w-3.5" />
      Подробный пересказ · EN · {detail.sources.map(sourceLabel).join(", ")} · ~{Math.max(1, Math.round(detail.chars / 1200))} мин чтения
    </button>
  );
  const cur = texts?.[Math.min(tab, (texts?.length ?? 1) - 1)];
  const ru = cur?.lang !== "ru" && !original ? cur?.translation : null;
  return (
    <div className="mt-2 rounded-lg bg-gray-900/60 ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-700/60 px-2 py-1.5">
        {texts?.map((t, i) => (
          <button key={t.source} onClick={() => setTab(i)}
            className={cx("rounded-md px-2 py-0.5 text-xs", i === tab ? "tone-accent soft" : "text-gray-400 hover:text-gray-200")}>
            {sourceLabel(t.source)} <span className="uppercase text-gray-500">{t.lang}</span>
          </button>
        ))}
        <button onClick={() => setOpen(false)} className="ml-auto px-2 text-xs text-gray-500 hover:text-gray-300">Свернуть</button>
      </div>
      {isLoading && <p className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500"><Spinner className="h-4 w-4" /> Загружаю…</p>}
      {cur && (
        <div className="px-3 py-3">
          {cur.lang !== "ru" && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              {cur.translation ? (
                <>
                  <button onClick={() => setOriginal(false)} className={cx("rounded-md px-2 py-0.5", !original ? "tone-info soft" : "text-gray-400 hover:text-gray-200")}>Русский</button>
                  <button onClick={() => setOriginal(true)} className={cx("rounded-md px-2 py-0.5", original ? "tone-info soft" : "text-gray-400 hover:text-gray-200")}>Оригинал</button>
                </>
              ) : (
                <button onClick={() => translate.mutate(cur.source)} disabled={translate.isPending} className="tone-info soft rounded-md px-2 py-0.5">
                  {translate.isPending
                    ? <span className="flex items-center gap-1.5"><Spinner className="h-3 w-3" /> Перевожу — {cur.text.length > 6000 ? "до пары минут" : "до минуты"}…</span>
                    : "Перевести на русский"}
                </button>
              )}
              {translate.error && <span className="text-negative-300">{String((translate.error as Error).message)}</span>}
            </div>
          )}
          <p className="max-h-[60vh] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-gray-300">{ru ? ru.text : cur.text}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-1 text-xs text-gray-500">
            {cur.url ? <a href={cur.url} target="_blank" rel="noreferrer" className="hover:text-gray-300">{sourceLabel(cur.source)}</a> : sourceLabel(cur.source)}
            {cur.source === "wiki-en" || cur.source === "fandom" ? " — текст под лицензией CC BY-SA" : ""}
            {ru && <span className="flex items-center gap-1">· <SparklesIcon className="h-3 w-3" /> перевод ИИ ({ru.model}), возможны неточности</span>}
          </p>
        </div>
      )}
    </div>
  );
}

const fmtDuration = (sec: number) => (sec < 60 ? `${Math.round(sec)} с` : `${Math.floor(sec / 60)} мин ${Math.round(sec % 60)} с`);

/** Сбор подробного сюжета (только админ): кнопка и ход сбора — шаг, сколько сделано, сколько осталось. */
function CorpusBar({ id }: { id: number }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const admin = Boolean(me?.isAdmin);
  const { data: st } = useQuery({
    queryKey: ["corpus", id], queryFn: () => api<CorpusState>(`/api/anime/${id}/corpus`), enabled: admin,
    refetchInterval: (q) => (q.state.data?.task && ["queued", "running"].includes(q.state.data.task.status) ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () => api<CorpusState>(`/api/anime/${id}/corpus`, { method: "POST" }),
    onSuccess: (s) => qc.setQueryData(["corpus", id], s),
  });
  const active = st?.task && ["queued", "running"].includes(st.task.status);
  const wasActive = useRef(false);
  useEffect(() => {
    // Сбор закончился — серии получили пометки «подробный пересказ»
    if (wasActive.current && !active) void qc.invalidateQueries({ queryKey: ["plot", id] });
    wasActive.current = Boolean(active);
  }, [active, id, qc]);
  if (!admin || !st) return null;
  const p = st.progress;
  const elapsed = p ? (p.updatedAt - p.startedAt) / 1000 : 0;
  const left = p && !p.finished && p.etaSec !== null ? p.etaSec : null;
  return (
    <div className="mt-3 rounded-xl bg-gray-800/40 px-4 py-3 text-sm ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-3">
        <DocumentTextIcon className="h-5 w-5 shrink-0 text-gray-400" />
        <span className="mr-auto text-gray-300">
          {active ? (st.task!.status === "queued" ? "Сбор сюжета в очереди…" : `Собираю сюжет: ${p?.step ?? "…"}`)
            : st.episodes ? `Подробный пересказ есть у ${st.deep} из ${st.episodes} серий` : "Подробного сюжета ещё нет: пересказы серий с Википедии, Fandom и японские анонсы"}
        </span>
        {!active && (
          <button onClick={() => start.mutate()} disabled={start.isPending} className="tone-accent soft rounded-lg px-3 py-1.5 font-medium">
            {st.episodes ? "Обновить сюжет" : "Собрать сюжет"}
          </button>
        )}
      </div>
      {active && p && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
            <div className="tone-accent solid h-full transition-all" style={{ width: `${Math.round((p.done / Math.max(1, p.total)) * 100)}%` }} />
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
            <span>{p.done} из {p.total}</span>
            <span>прошло {fmtDuration(elapsed)}</span>
            {left !== null && <span>осталось ~{fmtDuration(left)}</span>}
          </p>
        </div>
      )}
      {p && (Object.keys(p.found).length > 0 || p.errors.length > 0) && (
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
          {Object.entries(p.found).map(([s, n]) => <span key={s}>{sourceLabel(s)}: {n}</span>)}
          {p.errors.map((e) => <span key={e} className="text-negative-300">{e}</span>)}
        </p>
      )}
      {st.task?.status === "error" && <p className="mt-1 text-xs text-negative-300">{st.task.error}</p>}
      {start.error && <p className="mt-1 text-xs text-negative-300">{String((start.error as Error).message)}</p>}
    </div>
  );
}

/**
 * Пересказ сезона ИИ на момент досмотренной серии: состояние последней порции, целиком просмотренной
 * (модель шла слепо по порядку — дальше этой серии она ничего не знала).
 */
function SeasonRetelling({ season, seen, total }: { season: NonNullable<PlotInfo["season"]>; seen: number; total: number }) {
  const [open, setOpen] = useState(false);
  const { state } = stateAt(season.states, seen);
  const last = season.states.at(-1)!.upTo;
  return (
    <div className="mt-3 rounded-xl bg-gray-800/40 ring-1 ring-gray-700">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <BookOpenIcon className="h-5 w-5 shrink-0 text-gray-400" />
        <span className="mr-auto font-semibold">Пересказ сезона</span>
        <span className="text-xs text-gray-500">
          {!state ? `появится, когда досмотрите до серии ${season.states[0].upTo}` : state.upTo >= Math.min(last, total) ? "весь сезон" : `по серию ${state.upTo} — без спойлеров дальше`}
        </span>
      </button>
      {open && state && (
        <div className="space-y-3 border-t border-gray-700/60 px-4 py-4 text-sm">
          <p className="whitespace-pre-line leading-relaxed text-gray-300">{state.retelling_ru}</p>
          <p className="text-gray-400"><span className="text-gray-500">На конец серии {state.upTo}: </span>{state.ending_state_ru}</p>
          {state.characters.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wider text-gray-500">Персонажи</p>
              <ul className="grid gap-1 text-gray-300 sm:grid-cols-2">
                {state.characters.map((c) => <li key={c.name_en || c.name_ru}><span className="font-medium">{c.name_ru}</span> <span className="text-gray-500">— {c.role_ru}</span></li>)}
              </ul>
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-gray-500">
            <SparklesIcon className="h-3.5 w-3.5" /> Пересказ ИИ ({season.model}) по описаниям серий Википедии, Fandom, MyAnimeList — возможны неточности
          </p>
        </div>
      )}
    </div>
  );
}

type SdhState = { task: CorpusState["task"]; progress: CorpusState["progress"] };

/**
 * «Глубокий разбор» (админ): японские субтитры для слабослышащих с Jimaku → конспект каждой серии по сценам →
 * корпус и пересказ сезона. Файлы субтитров остаются только на сервере.
 */
function SdhBar({ id }: { id: number }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const admin = Boolean(me?.isAdmin);
  const { data: st } = useQuery({
    queryKey: ["sdh", id], queryFn: () => api<SdhState>(`/api/anime/${id}/sdh`), enabled: admin,
    refetchInterval: (q) => (q.state.data?.task && ["queued", "running"].includes(q.state.data.task.status) ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () => api<SdhState>(`/api/anime/${id}/sdh`, { method: "POST" }),
    onSuccess: (s) => qc.setQueryData(["sdh", id], s),
  });
  const active = st?.task && ["queued", "running"].includes(st.task.status);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      void qc.invalidateQueries({ queryKey: ["plot", id] });
      void qc.invalidateQueries({ queryKey: ["corpus", id] });
    }
    wasActive.current = Boolean(active);
  }, [active, id, qc]);
  if (!admin || !st) return null;
  const p = st.progress;
  const elapsed = p ? (p.updatedAt - p.startedAt) / 1000 : 0;
  return (
    <div className="mt-2 rounded-xl bg-gray-800/40 px-4 py-3 text-sm ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-3">
        <SparklesIcon className="h-5 w-5 shrink-0 text-gray-400" />
        <span className="mr-auto text-gray-300">
          {active ? (st.task!.status === "queued" ? "Глубокий разбор в очереди…" : `Глубокий разбор: ${p?.step ?? "…"}`)
            : p?.finished ? `Конспектов серий по субтитрам: ${p.found.sdh ?? 0}` : "Глубокий разбор: японские субтитры для слабослышащих → конспект каждой серии"}
        </span>
        {!active && (
          <button onClick={() => start.mutate()} disabled={start.isPending} className="tone-special soft rounded-lg px-3 py-1.5 font-medium">
            Глубокий разбор
          </button>
        )}
      </div>
      {active && p && (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
            <div className="tone-special solid h-full transition-all" style={{ width: `${Math.round((p.done / Math.max(1, p.total)) * 100)}%` }} />
          </div>
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
            <span>{p.done} из {p.total}</span>
            <span>прошло {fmtDuration(elapsed)}</span>
            {p.etaSec !== null && !p.finished && <span>осталось ~{fmtDuration(p.etaSec)}</span>}
          </p>
        </div>
      )}
      {p && p.errors.length > 0 && <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-negative-300">{p.errors.map((e) => <span key={e}>{e}</span>)}</p>}
      {st.task?.status === "error" && <p className="mt-1 text-xs text-negative-300">{st.task.error}</p>}
    </div>
  );
}

function Overview({ text, en, ai }: { text: string; en: boolean; ai?: boolean }) {
  const [full, setFull] = useState(false);
  return (
    <p onClick={() => setFull((v) => !v)} className={cx("mt-1 cursor-pointer whitespace-pre-line text-sm text-gray-400", !full && "line-clamp-2")}>
      {ai && <SparklesIcon className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-gray-500" />}
      {en && <span className="mr-1.5 rounded bg-gray-700 px-1 py-px align-middle text-[10px] font-medium text-gray-300">EN</span>}
      {text}
    </p>
  );
}
