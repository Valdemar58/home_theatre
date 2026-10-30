"use client";
// Клиентские запросы к API и хуки React Query.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BookLite, BookPage, BookProgress, BookRelation, ChapterContentView } from "./books";
import { useMemo } from "react";
import type { Me } from "@/app/api/me/route";
import type { AnimeDetails, CharacterDetails, EventDetails, FranchiseView, NameRefs, PlaceDetails, PlotMap, PlotViewMode, TitlePlaces, RelationMap, TitleCast, TitleEvents, AnimeImages, MatchInfo, PlotInfo, SimilarItem, CalendarResponse, ListEntryWithMedia, ListStatus, MediaLite, SeerrStatus, Notice, NoticeCounts, FriendOpinion, FriendPick, Person, SharedListDetail, SharedListSummary, TogetherState, Profile, TaskInfo, VoicesState } from "./types";
import { applyProgress } from "./entry-rules";
import type { EpisodeStatus, TorrentCache } from "./playback";
import { reportStale } from "./stale-data";

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
  }
  // Данные из сохранённого (источник недоступен) — для плашки в шапке
  reportStale(res.headers.get("X-Data-Stale"));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), staleTime: 60_000 });

export const useCalendar = (from: number, to: number) =>
  useQuery({
    queryKey: ["calendar", from, to],
    queryFn: () => api<CalendarResponse>(`/api/calendar?from=${from}&to=${to}`),
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });

export const useAnime = (id: number) =>
  useQuery({ queryKey: ["anime", id], queryFn: () => api<AnimeDetails>(`/api/anime/${id}`), staleTime: 10 * 60_000, enabled: id > 0 });

export const useMatch = (id: number, enabled = true) =>
  useQuery({ queryKey: ["match", id], queryFn: () => api<MatchInfo>(`/api/anime/${id}/match`), staleTime: 10 * 60_000, enabled });

/** Сюжет: пока синопсис составляется (pending) — перезапрашиваем каждые 5 с */
export const usePlot = (id: number) =>
  useQuery({
    queryKey: ["plot", id], queryFn: () => api<PlotInfo>(`/api/anime/${id}/plot`), staleTime: 10 * 60_000, enabled: id > 0,
    refetchInterval: (q) => (q.state.data?.pending ? 5000 : false),
  });


export const useCharacter = (param: string) =>
  useQuery({ queryKey: ["character", param], queryFn: () => api<CharacterDetails>(`/api/characters/${param}`), staleTime: 600_000, enabled: Boolean(param) });

/** Персонажи тайтла на серию курсора; at — «показать спойлер» (весь сезон) */
export const useTitleCast = (id: number, at?: "all") =>
  useQuery({ queryKey: ["cast", id, at ?? "cursor"], queryFn: () => api<TitleCast>(`/api/anime/${id}/cast${at ? `?at=${at}` : ""}`), staleTime: 600_000, enabled: id > 0 });

/** Франшиза тайтла; пока архив догружает страницы связанных тайтлов — переспрашиваем */
export const useFranchise = (id: number) =>
  useQuery({
    queryKey: ["franchise", id], queryFn: () => api<FranchiseView>(`/api/franchise/${id}`), staleTime: 60_000, enabled: id > 0,
    refetchInterval: (q) => (q.state.data?.partial ? 8000 : false),
  });

/** «Сюжет на серию»: прогресс по списку не меняется, меняется всё, что показано о сюжете тайтла */
export function usePlotView(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { mode: PlotViewMode; ep?: number | null }) => api<TitleCast>(`/api/anime/${id}/cast`, { method: "PUT", json: v }),
    onSuccess: (cast) => {
      qc.setQueryData(["cast", id, "cursor"], cast);
      void qc.invalidateQueries({ queryKey: ["names", id] });
      void qc.invalidateQueries({ queryKey: ["character"] });
      void qc.invalidateQueries({ queryKey: ["events", id] });
      void qc.invalidateQueries({ queryKey: ["relations", id] });
      void qc.invalidateQueries({ queryKey: ["plot-map", id] });
      void qc.invalidateQueries({ queryKey: ["places", id] });
    },
  });
}

/** События тайтла по аркам и страница события — на «Сюжет на серию» */
export const useTitleEvents = (id: number) =>
  useQuery({ queryKey: ["events", id], queryFn: () => api<TitleEvents>(`/api/anime/${id}/events`), staleTime: 600_000, enabled: id > 0 });
export const useEvent = (id: number, key: string) =>
  useQuery({ queryKey: ["events", id, key], queryFn: () => api<EventDetails>(`/api/anime/${id}/events/${encodeURIComponent(key)}`), staleTime: 600_000, enabled: id > 0 && Boolean(key) });

/** Карта персонажей на «Сюжет на серию» */
export const useTitlePlaces = (id: number) =>
  useQuery({ queryKey: ["places", id], queryFn: () => api<TitlePlaces>(`/api/anime/${id}/places`), staleTime: 600_000, enabled: id > 0 });

export const usePlace = (id: number, placeId: number) =>
  useQuery({ queryKey: ["places", id, placeId], queryFn: () => api<PlaceDetails>(`/api/anime/${id}/places/${placeId}`), staleTime: 600_000, enabled: id > 0 && placeId > 0 });

export const usePlotMap = (id: number) =>
  useQuery({ queryKey: ["plot-map", id], queryFn: () => api<PlotMap>(`/api/anime/${id}/map`), staleTime: 600_000, enabled: id > 0 });

export const useRelationMap = (id: number) =>
  useQuery({ queryKey: ["relations", id], queryFn: () => api<RelationMap>(`/api/anime/${id}/relations`), staleTime: 600_000, enabled: id > 0 });

/** Имена для подсветки в тексте о сериях до upTo */
export const useNameRefs = (id: number, upTo: number | null) =>
  useQuery({ queryKey: ["names", id, upTo], queryFn: () => api<NameRefs>(`/api/anime/${id}/names${upTo !== null ? `?upTo=${upTo}` : ""}`), staleTime: 600_000, enabled: id > 0 });

export const useSimilar = (id: number) =>
  useQuery({ queryKey: ["similar", id], queryFn: () => api<SimilarItem[]>(`/api/anime/${id}/similar`), staleTime: 30 * 60_000 });

export const useAnimeImages = (id: number) =>
  useQuery({ queryKey: ["anime-images", id], queryFn: () => api<AnimeImages>(`/api/anime/${id}/images`), staleTime: 30 * 60_000, enabled: id > 0 });

export const useGenres = () =>
  useQuery({ queryKey: ["genres"], queryFn: () => api<string[]>("/api/genres"), staleTime: Infinity });

export const useSeerr = (id: number, enabled = true) =>
  useQuery({ queryKey: ["seerr", id], queryFn: () => api<SeerrStatus>(`/api/seerr/${id}`), enabled, staleTime: 60_000 });

/** Готовность серий к просмотру, кэш раздач и мои позиции в сериях. */
export const useEpisodeStatus = (id: number, enabled = true) =>
  useQuery({
    queryKey: ["episode-status", id],
    queryFn: () => api<{ episodes: EpisodeStatus[]; aired: number | null; caches: TorrentCache[]; positions: { ep: number; pos: number; dur: number | null }[] }>(`/api/anime/${id}/episodes`),
    enabled: enabled && id > 0,
    staleTime: 15_000,
    // Готовится или качается — раз в 5 с; раздача активна (смотрят, кэш растёт) — раз в 15 с
    refetchInterval: (q) => (q.state.data?.episodes.some((e) => e.preparing || e.state === "downloading") ? 5000
      : q.state.data?.caches.some((c) => c.active) ? 15_000 : 60_000),
  });

/** Озвучки: найденное фоновой задачей; пока задача идёт — опрос раз в 3 с. */
export const useVoices = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ["voices", id],
    queryFn: () => api<VoicesState>(`/api/ru/releases/${id}`),
    enabled,
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.task && ["queued", "running"].includes(q.state.data.task.status) ? 3000 : false),
  });

/** Запустить фоновую задачу (или присоединиться к идущей). */
export const startTask = (kind: string, key: string | number, origin: "user" | "auto") =>
  api<{ task: TaskInfo | null }>("/api/tasks", { method: "POST", json: { kind, key: String(key), origin } });

/** Ушли со страницы, не нажав кнопку: отменить автоматическую задачу (переживает закрытие вкладки). */
export const cancelAutoTask = (kind: string, key: string | number) =>
  navigator.sendBeacon("/api/tasks/cancel", JSON.stringify({ kind, key: String(key) }));

/** Уведомления: опрос раз в 15 с (новые показывает тостом Notifications). */
export const usePeople = () => useQuery({ queryKey: ["people"], queryFn: () => api<Person[]>("/api/friends"), staleTime: 30_000 });
export const useProfile = (id: number) =>
  useQuery({ queryKey: ["profile", id], queryFn: () => api<Profile>(`/api/users/${id}`), staleTime: 30_000 });
export const useUserList = (id: number, enabled = true) =>
  useQuery({ queryKey: ["user-list", id], queryFn: () => api<ListEntryWithMedia[]>(`/api/users/${id}/list`), enabled, staleTime: 60_000 });

export const useOpinions = (id: number) =>
  useQuery({ queryKey: ["opinions", id], queryFn: () => api<FriendOpinion[]>(`/api/anime/${id}/opinions`), enabled: id > 0, staleTime: 60_000 });

export const useFriendPicks = () =>
  useQuery({ queryKey: ["friend-picks"], queryFn: () => api<FriendPick[]>("/api/recommendations/friends"), staleTime: 60_000 });

export const useTogether = (id: number) =>
  useQuery({ queryKey: ["together", id], queryFn: () => api<TogetherState>(`/api/anime/${id}/together`), enabled: id > 0, staleTime: 15_000 });
export const useSharedLists = () =>
  useQuery({ queryKey: ["shared-lists"], queryFn: () => api<SharedListSummary[]>("/api/shared-lists"), staleTime: 30_000 });
export const useSharedList = (id: number) =>
  useQuery({ queryKey: ["shared-list", id], queryFn: () => api<SharedListDetail>(`/api/shared-lists/${id}`), staleTime: 15_000 });

export type NoticesPage = { items: Notice[]; unread: NoticeCounts; hasMore: boolean };
const noticesUrl = (group: string, limit: number, extra = "") => `/api/notifications?group=${group}&limit=${limit}${extra}`;

/** Последние уведомления (опрос раз в 15 с): счётчики для колокольчика и новые — для тостов. */
export const useNotices = () =>
  useQuery({
    queryKey: ["notices", "poll"],
    queryFn: () => api<NoticesPage>(noticesUrl("all", 8)),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

/** Вкладка уведомлений (окно колокольчика). */
export const useNoticeTab = (group: string, enabled: boolean) =>
  useQuery({ queryKey: ["notices", "tab", group], queryFn: () => api<NoticesPage>(noticesUrl(group, 8)), enabled, staleTime: 5_000 });

/** Действия с уведомлениями; после — обновить все списки уведомлений. */
export function useNoticeActions() {
  const qc = useQueryClient();
  const run = (action: "read" | "unread" | "delete" | "delete-read", ids?: number[], group?: string) =>
    api("/api/notifications", { method: "POST", json: { action, ids, group } })
      .then(() => qc.invalidateQueries({ queryKey: ["notices"] }))
      .catch(() => undefined);
  return {
    read: (ids?: number[], group?: string) => run("read", ids, group),
    unread: (ids: number[]) => run("unread", ids),
    remove: (ids: number[]) => run("delete", ids),
    removeRead: (group?: string) => run("delete-read", undefined, group),
  };
}

export function useList() {
  const query = useQuery({ queryKey: ["list"], queryFn: () => api<ListEntryWithMedia[]>("/api/list"), staleTime: 60_000 });
  const byId = useMemo(() => new Map((query.data ?? []).map((e) => [e.anilistId, e])), [query.data]);
  return { ...query, byId };
}

export type EntryPatch = Partial<{
  status: ListStatus; waiting: boolean; episodes: number; score: number;
  note: string | null; tags: string[]; voice: string | null; recommend: boolean | null; private: boolean;
}>;

/** Изменение записи списка с оптимистичным обновлением. */
export function useListMutation() {
  const qc = useQueryClient();
  const update = (fn: (list: ListEntryWithMedia[]) => ListEntryWithMedia[]) =>
    qc.setQueryData<ListEntryWithMedia[]>(["list"], (old) => fn(old ?? []));

  const upsert = useMutation({
    mutationFn: ({ media, patch }: { media: MediaLite; patch: EntryPatch }) =>
      api(`/api/list/${media.id}`, { method: "PUT", json: patch }),
    onMutate: async ({ media, patch }) => {
      await qc.cancelQueries({ queryKey: ["list"] });
      const prev = qc.getQueryData<ListEntryWithMedia[]>(["list"]);
      update((list) => {
        const existing = list.find((e) => e.anilistId === media.id);
        const base = {
          anilistId: media.id, malId: media.idMal, score: 0, note: null, tags: [], voice: null, recommend: null, private: false,
          updatedAt: Date.now() / 1000, media, ...existing,
          ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as EntryPatch),
        };
        // статус и серии — по тем же правилам, что на сервере
        const next = { ...base, ...applyProgress(existing ?? null, patch, media) } as ListEntryWithMedia;
        return [next, ...list.filter((e) => e.anilistId !== media.id)];
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["list"], ctx.prev),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["list"] });
      // Отметка серий могла засчитаться друзьям, породить подсказку «отметить и для …?» или новый уровень награды
      // (награды пересчитываются уже после ответа — второй запрос чуть позже)
      void qc.invalidateQueries({ queryKey: ["notices"] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["notices"] }), 2000);
      void qc.invalidateQueries({ queryKey: ["together"] });
      void qc.invalidateQueries({ queryKey: ["shared-list"] });
      // Прогресс сдвинул курсор сюжета — персонажи и имена на новую серию
      void qc.invalidateQueries({ queryKey: ["cast"] });
      void qc.invalidateQueries({ queryKey: ["names"] });
      void qc.invalidateQueries({ queryKey: ["character"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/list/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["list"] });
      const prev = qc.getQueryData<ListEntryWithMedia[]>(["list"]);
      update((list) => list.filter((e) => e.anilistId !== id));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["list"], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["list"] }),
  });

  return { upsert, remove };
}

/** Русское название тега AniList (если уже переведено), иначе английское. */
export function useTagLabel(): (name: string) => string {
  const { data } = useQuery({ queryKey: ["tags-ru"], queryFn: () => api<Record<string, string>>("/api/tags"), staleTime: 3600_000 });
  return (name: string) => data?.[name] ?? name;
}

// ---------------------------------------------------------------- книги (заход 5)

/** Страница книги; пока провайдеры ищут и обновляют оглавления — опрос раз в 5 с. */
export const useBook = (id: number) =>
  useQuery({
    queryKey: ["book", id], queryFn: () => api<BookPage>(`/api/books/${id}`), enabled: id > 0, staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.updating ? 5000 : false),
  });

export const useBookProgress = (id: number) =>
  useQuery({ queryKey: ["book-progress", id], queryFn: () => api<BookProgress>(`/api/books/${id}/progress`), enabled: id > 0 });

export const useBookChapter = (id: number, provider: string | null, cref: string | null) =>
  useQuery({
    queryKey: ["book-chapter", id, provider, cref], enabled: Boolean(id > 0 && provider && cref), staleTime: Infinity, retry: 1,
    queryFn: () => api<ChapterContentView>(`/api/books/${id}/chapter?provider=${encodeURIComponent(provider!)}&cref=${encodeURIComponent(cref!)}`),
  });

export type ReadListItem = { bookId: number; status: string; chapters: number; score: number; updatedAt: number; book: BookLite };
export const useReadList = () => useQuery({ queryKey: ["read-list"], queryFn: () => api<{ items: ReadListItem[] }>("/api/books/list") });

export const useBooksForAnime = (id: number) =>
  useQuery({ queryKey: ["anime-books", id], queryFn: () => api<{ books: (BookRelation & { ru: string | null })[] }>(`/api/books/for-anime/${id}`), enabled: id > 0, staleTime: 3600_000 });
