"use client";
import { CheckIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, useNoticeActions, useNotices, type NoticesPage } from "@/lib/client";
import { useUrlState } from "@/lib/useUrlState";
import { EMPTY, NoticeList, NoticeListSkeleton, NoticeTabs } from "./Notifications";
import { Button } from "./ui";
import { useConfirm } from "./Dialogs";

// Все уведомления: вкладки, «только непрочитанные», «Прочитать все», «Удалить прочитанные», подгрузка истории.

const PAGE = 30;

export function NotificationsView() {
  const { params, setParams } = useUrlState();
  const tab = params.get("tab") ?? "all";
  const unreadOnly = params.get("unread") === "1";
  const { data: poll } = useNotices();
  const act = useNoticeActions();
  const confirm = useConfirm();
  const q = useInfiniteQuery({
    queryKey: ["notices", "page", tab, unreadOnly],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<NoticesPage>(`/api/notifications?group=${tab}&limit=${PAGE}${unreadOnly ? "&unread=1" : ""}${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.hasMore ? last.items.at(-1)?.id : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = poll?.unread ?? q.data?.pages[0]?.unread;
  const inTab = unread?.[tab as keyof typeof unread] ?? 0;

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold sm:text-3xl">Уведомления</h1>
      <div className="flex flex-wrap items-center gap-3">
        <NoticeTabs value={tab} onChange={(g) => setParams({ tab: g === "all" ? null : g })} unread={unread} />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-300">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setParams({ unread: e.target.checked ? "1" : null })} className="accent-indigo-500" />
          только непрочитанные
        </label>
        <span className="ml-auto flex gap-2">
          <Button size="sm" disabled={!inTab} onClick={() => act.read(undefined, tab)}><CheckIcon className="h-4 w-4" />Прочитать все</Button>
          <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: "Удалить прочитанные уведомления?", text: "Только в этой вкладке. Непрочитанные останутся.", confirm: "Удалить", danger: true })) void act.removeRead(tab); }}>
            <TrashIcon className="h-4 w-4" />Удалить прочитанные
          </Button>
        </span>
      </div>
      <div className="overflow-hidden rounded-xl bg-gray-800/60 ring-1 ring-gray-700">
        {q.isLoading ? <NoticeListSkeleton count={6} />
          : <NoticeList items={items} empty={unreadOnly ? "Непрочитанных нет." : EMPTY[tab]} />}
      </div>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? "Загружаю…" : "Показать ещё"}</Button>
        </div>
      )}
    </div>
  );
}
