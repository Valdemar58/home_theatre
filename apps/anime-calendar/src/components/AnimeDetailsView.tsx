"use client";
import { ArrowTopRightOnSquareIcon, FlagIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useState } from "react";
import { useAnime, useAnimeImages, useList, useMe, useSimilar, useTagLabel } from "@/lib/client";
import {
  COUNTRY_LABELS, FORMAT_LABELS, GENRE_LABELS, label, LIST_LABELS, RELATION_LABELS, SEASON_LABELS, SOURCE_LABELS, STATUS_LABELS,
} from "@/lib/labels";
import type { GalleryImage, SimilarItem } from "@/lib/types";
import { displayTitle, finaleOf, secondaryTitle } from "@/lib/schedule";
import { imgSrc } from "@/lib/img";
import { formatAiring, fuzzyDate, pluralEpisodes, relative } from "@/lib/time";
import { useRememberTitle } from "./Breadcrumbs";
import { Gallery } from "./Gallery";
import { MatchBadge } from "./MatchBadge";
import { Discussion } from "./Discussion";
import { EpisodeAlerts } from "./EpisodeAlerts";
import { FriendOpinions } from "./FriendOpinions";
import { Impressions } from "./Impressions";
import { Lightbox } from "./Lightbox";
import { ListControl } from "./ListControl";
import { NextEpisode, useNow } from "./NextEpisode";
import { PlotHub } from "./PlotHub";
import { Description, Episodes } from "./Plot";
import { RequestButton } from "./RequestButton";
import { TogetherBar } from "./TogetherBar";
import { Scores } from "./Scores";
import { VoicesButton } from "./VoicesButton";
import { TitleCard } from "./TitleCard";
import { Videos } from "./Videos";
import { Badge, cx, ErrorBox, Segmented, Spinner } from "./ui";
import { Img, UpscaleBadge } from "./Img";

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "" || children === "—") return null;
  return (
    <div className="flex justify-between gap-4 border-b border-gray-700/60 px-4 py-2.5 text-sm last:border-0">
      <span className="text-gray-400">{name}</span>
      <span className="text-right font-medium text-gray-200">{children}</span>
    </div>
  );
}

export function AnimeDetailsView({ id, openVoices, together, undo, comment }: {
  id: number; openVoices?: boolean; together?: number; undo?: number; comment?: number;
}) {
  const { data: a, error, isLoading } = useAnime(id);
  useRememberTitle(id);
  const { data: me } = useMe();
  const { data: gallery } = useAnimeImages(id);
  const { data: similar } = useSimilar(id);
  const tagLabel = useTagLabel();
  const { byId: myList } = useList();
  const now = useNow();
  // Галерея на странице и полноэкранный просмотр листают один и тот же индекс
  const [shot, setShot] = useState(0);
  const [simSort, setSimSort] = useState<"similarity" | "match">("similarity");
  // Индекс в полноэкранном просмотре: 0 — постер из шапки, дальше — галерея (shot + 1)
  const [viewer, setViewer] = useState<number | null>(null);

  if (isLoading) return <div className="flex h-96 items-center justify-center"><Spinner className="h-8 w-8" /></div>;
  if (error || !a) return <ErrorBox error={error ?? "Не найдено"} />;

  const finale = finaleOf(a, a.schedule);
  const alt = secondaryTitle(a.title);
  const season = a.season ? `${SEASON_LABELS[a.season]} ${a.seasonYear}` : a.seasonYear;
  const images = gallery?.images ?? [];
  // Фон: пока галерея грузится — баннер AniList, потом лучшая широкая картинка
  const backdrop = gallery?.backdrop ?? a.bannerImage;
  const cover = a.coverXL ?? a.coverImage.large;
  const viewerImages: GalleryImage[] = cover ? [{ url: cover, thumb: a.coverImage.large ?? cover, kind: "poster", source: "AniList" }, ...images] : images;
  const offset = cover ? 1 : 0;
  // День недели выхода серий — по ближайшей серии, у вышедших — по последней
  const airDay = a.nextAiringEpisode?.airingAt ?? a.schedule.at(-1)?.airingAt;
  // Продолжение того, что я уже смотрел: предыстория или основная история есть в моём списке (не в планах)
  const continues = a.relations
    .filter((r) => r.relationType === "PREQUEL" || r.relationType === "PARENT")
    .map((r) => ({ media: r.media, entry: myList.get(r.media.id) }))
    .filter((r) => r.entry && r.entry.status !== "planned");

  return (
    <div className="-mx-4 -mt-6 lg:-mx-8">
      {/* Фон: баннер AniList, фон TMDB или кадр; если ничего нет — размытый постер */}
      <div className="relative h-64 overflow-hidden sm:h-96" style={{ backgroundColor: a.coverImage.color ?? "#1f2937" }}>
        {(backdrop || a.coverImage.large) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc(backdrop ?? a.coverImage.large!, "full")} alt=""
            className={cx("h-full w-full object-cover object-[50%_25%]", !backdrop && "scale-110 opacity-60 blur-2xl")} />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-gray-900 via-gray-900/50 to-gray-900/0" />
        <div className="absolute inset-0 bg-linear-to-r from-gray-900/70 to-transparent" />
      </div>

      <div className="relative -mt-40 px-4 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row">
          {/* self-start: иначе кнопка тянется по высоте колонки и центрирует постер (он «съезжает» при раскрытии «почему») */}
          <button onClick={() => viewerImages.length && setViewer(0)} className="group relative w-48 shrink-0 self-start sm:w-72" title="Открыть на весь экран">
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl shadow-2xl ring-1 ring-gray-700 transition group-hover:ring-indigo-400"
              style={{ backgroundColor: a.coverImage.color ?? undefined }}>
              {cover && <Img src={cover} size="full" lazy={false} className="absolute inset-0 h-full w-full object-cover" />}
              <UpscaleBadge src={cover} className="absolute left-2 top-2" />
            </div>
            {viewerImages.length > 1 && (
              <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white opacity-0 transition group-hover:opacity-100">
                {viewerImages.length} фото
              </span>
            )}
          </button>
          <div className="flex-1 space-y-3 sm:pt-20">
            <div className="flex flex-wrap gap-2">
              <Badge tone="neutral">{label(FORMAT_LABELS, a.format)}</Badge>
              <Badge tone={a.status === "RELEASING" ? "positive" : "neutral"}>{label(STATUS_LABELS, a.status)}</Badge>
              {a.isAdult && <Badge tone="negative">18+</Badge>}
              {continues.map(({ media, entry }) => (
                <Link key={media.id} href={`/anime/${media.id}`} title={`${displayTitle(media.title)} — ${LIST_LABELS[entry!.status]}`}
                  className="inline-flex min-w-0">
                  <Badge tone="accent" className="max-w-80 transition hover:brightness-125">
                    <span className="min-w-0 truncate">Продолжение «{displayTitle(media.title)}»</span>
                  </Badge>
                </Link>
              ))}
            </div>
            <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{displayTitle(a.title)}</h1>
            {alt && <p className="text-gray-400">{alt}{a.title.native ? ` · ${a.title.native}` : ""}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-300">
              {season && <span>{season}</span>}
              {a.episodes && <span>{pluralEpisodes(a.episodes)}</span>}
              {a.duration && <span>по {a.duration} мин</span>}
              <Scores media={a} size="md" />
              {a.studios.length > 0 && <span>{a.studios.join(", ")}</span>}
            </div>
            <MatchBadge id={a.id} />
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <ListControl media={a} />
              <RequestButton media={a} />
              <VoicesButton media={a} autoFetch initialOpen={openVoices} />
              <EpisodeAlerts id={a.id} airing={a.status === "RELEASING" || a.status === "NOT_YET_RELEASED"} />
            </div>
            <TogetherBar media={a} together={together} undo={undo} />
          </div>
        </div>

        {/* Следующая серия (если она не финал — финал показан ниже отдельно) */}
        {a.nextAiringEpisode && (
          <div className="mt-8">
            <NextEpisode media={a} />
          </div>
        )}

        {/* Финал */}
        {finale?.airingAt && finale.episode !== a.nextAiringEpisode?.episode && (
          <div className={cx(
            "mt-8 flex flex-wrap items-center gap-4 rounded-xl p-5 ring-1",
            finale.airingAt * 1000 > now ? "bg-linear-to-r from-indigo-600/25 to-purple-600/25 ring-purple-500/50" : "bg-gray-800/60 ring-gray-700")}>
            <FlagIcon className="h-8 w-8 text-purple-300" />
            <div>
              <p className="text-xl font-semibold" title={formatAiring(finale.airingAt).tzName}>
                <span className="font-normal text-gray-300">{finale.airingAt * 1000 > now ? "Финальная серия" : "Финальная серия вышла"}</span>{" "}
                {finale.episode}{a.episodes ? ` из ${a.episodes}` : ""} · {formatAiring(finale.airingAt).date} {formatAiring(finale.airingAt).time}{" "}
                <span className="text-sm font-normal text-gray-400">{formatAiring(finale.airingAt).tz}</span>
              </p>
              {finale.tentative && <p className="text-sm text-gray-400">Предварительно: число серий ещё не объявлено</p>}
            </div>
            <span className="ml-auto text-2xl font-bold text-purple-200">{relative(finale.airingAt, now)}</span>
          </div>
        )}

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-8">
            <Description media={a} />

            <PlotHub media={a} />

            <Impressions media={a} />

            {images.length > 1 && (
              <section>
                <h2 className="mb-3 text-xl font-bold">Кадры и арт <span className="text-base font-normal text-gray-500">{images.length}</span></h2>
                <Gallery images={images} index={shot} onIndex={setShot} onOpen={() => setViewer(shot + offset)} />
              </section>
            )}

            {gallery && <Videos videos={gallery.videos} />}

            <Episodes media={a} entry={myList.get(a.id)} now={now} />

            {a.relations.length > 0 && (
              <section>
                <h2 className="mb-3 text-xl font-bold">Связанное</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {a.relations.map((r) => (
                    <TitleCard key={r.media.id} media={r.media}
                      footer={<p className="text-center text-xs text-gray-400">{label(RELATION_LABELS, r.relationType)}</p>} />
                  ))}
                </div>
              </section>
            )}

            {similar && similar.length > 0 && (
              <section>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <h2 className="mr-auto text-xl font-bold">Похожее</h2>
                  <Segmented value={simSort} onChange={setSimSort}
                    options={[["similarity", "Самое похожее"], ["match", "Понравится больше"]]} />
                </div>
                <p className="-mt-1 mb-3 text-xs text-gray-500">
                  {simSort === "similarity"
                    ? "Плашка — насколько похоже: теги и жанры AniList, рекомендации зрителей. Франшизы — одним первым сезоном."
                    : "Плашка — прогноз, насколько понравится вам: по вашим оценкам и «рекомендую»."}
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {sortSimilar(similar, simSort).map((s) => (
                    <TitleCard key={s.media.id} media={s.media} entry={myList.get(s.media.id)}
                      hoverExtra={{ similarity: { value: s.similarity, to: displayTitle(a.title) } }}
                      corner={simSort === "similarity" ? { kind: "similarity", value: s.similarity } : s.match != null ? { kind: "match", value: s.match } : null} />
                  ))}
                </div>
              </section>
            )}

            <Discussion anilistId={a.id} highlight={comment} />
          </div>

          <aside className="space-y-4">
            <FriendOpinions id={a.id} />
            {a.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.genres.map((g) => <Badge key={g} tone="accent">{GENRE_LABELS[g] ?? g}</Badge>)}
              </div>
            )}
            {a.tags.filter((t) => !t.spoiler && t.rank >= 60).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.tags.filter((t) => !t.spoiler && t.rank >= 60).slice(0, 12).map((t) => <span key={t.name} title={t.name}><Badge>{tagLabel(t.name)}</Badge></span>)}
              </div>
            )}
            <div className="overflow-hidden rounded-xl bg-gray-800/60 ring-1 ring-gray-700">
              <Fact name="Статус">{label(STATUS_LABELS, a.status)}</Fact>
              <Fact name="Начало">{fuzzyDate(a.startDate)}</Fact>
              <Fact name="Окончание">{fuzzyDate(a.endDate)}</Fact>
              {airDay && (
                <Fact name={`День выхода (${formatAiring(airDay).tz})`}>
                  <span className="capitalize">{formatAiring(airDay).weekday}</span>, {formatAiring(airDay).time}
                </Fact>
              )}
              <Fact name="Страна">{label(COUNTRY_LABELS, a.countryOfOrigin)}</Fact>
              <Fact name="Первоисточник">{label(SOURCE_LABELS, a.source)}</Fact>
              <Fact name="Популярность">{a.popularity.toLocaleString("ru-RU")}</Fact>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <a className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200" href={`https://anilist.co/anime/${a.id}`} target="_blank" rel="noreferrer">
                AniList <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
              {a.idMal && (
                <a className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200" href={`${me?.shikimori.url ?? "https://shikimori.io"}/animes/${a.idMal}`} target="_blank" rel="noreferrer">
                  Shikimori <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                </a>
              )}
              {a.trailer?.site === "youtube" && (
                <a className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200" href={`https://www.youtube.com/watch?v=${a.trailer.id}`} target="_blank" rel="noreferrer">
                  Трейлер <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                </a>
              )}
            </div>
          </aside>
        </div>
      </div>
      {viewer !== null && viewerImages.length > 0 && (
        <Lightbox images={viewerImages} index={Math.min(viewer, viewerImages.length - 1)}
          onIndex={(n) => { setViewer(n); if (n >= offset) setShot(n - offset); }} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}

/** «Похожее»: по похожести или по прогнозу; просмотренное — в конце (для сравнения). */
function sortSimilar(items: SimilarItem[], by: "similarity" | "match"): SimilarItem[] {
  const key = (i: SimilarItem) => (by === "similarity" ? i.similarity : (i.match ?? -1));
  return [...items].sort((a, b) => Number(a.watched) - Number(b.watched) || key(b) - key(a));
}
