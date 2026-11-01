"use client";
import { MagnifyingGlassIcon, PencilIcon, TrashIcon, UserPlusIcon, UsersIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, useMe, usePeople, useSharedList, useTogether } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import { ago } from "@/lib/time";
import type { MediaLite, SharedItem, SharedListDetail } from "@/lib/types";
import { useUrlState } from "@/lib/useUrlState";
import { Avatar } from "./Avatar";
import { useHoverCard } from "./HoverCard";
import { Img } from "./Img";
import { useConfirm } from "./Dialogs";
import { GroupPlan } from "./GroupPlan";
import { GroupsTitle } from "./SharedListsView";
import { Button, EmptyState, ErrorBox, Skel, cx } from "./ui";
import { WatchTogetherDialog } from "./WatchTogetherDialog";

// Группа (общий список): участники, план группы (сеансы, очередь, голосование, пульт — GroupPlan), тайтлы с живыми
// статусами каждого, «Посмотрели вместе», добавление поиском.

const TABS = [["watching", "Смотрим"], ["planned", "В планах"], ["done", "Все посмотрели"]] as const;
type Tab = (typeof TABS)[number][0];

function memberText(s: SharedItem["members"][number], total: number | null) {
  if (s.hidden) return "скрыто";
  if (!s.status) return "—";
  if (s.status === "completed") return "досмотрел";
  if (s.episodes > 0) return `${s.episodes}${total ? `/${total}` : ""}`;
  return LIST_LABELS[s.status].toLowerCase();
}

function ItemRow({ item, list, onTogether, onRemove }: { item: SharedItem; list: SharedListDetail; onTogether: () => void; onRemove: () => void }) {
  const m = item.media;
  const hover = useHoverCard(m);
  const name = (id: number | null) => list.members.find((x) => x.id === id)?.name;
  return (
    <li className="flex gap-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <Link {...hover} href={`/anime/${m.id}`} className="relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg sm:w-20" style={{ backgroundColor: m.coverImage.color ?? undefined }}>
        {m.coverImage.large && <Img src={m.coverImage.large} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <Link href={`/anime/${m.id}`} className="min-w-0 flex-1 font-semibold leading-snug hover:text-indigo-300">{displayTitle(m.title)}</Link>
          <button onClick={onRemove} title="Убрать из списка" className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-gray-200"><TrashIcon className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {item.members.map((s) => {
            const who = list.members.find((x) => x.id === s.userId);
            if (!who) return null;
            return (
              <span key={s.userId} title={s.updatedAt ? `${who.name}: ${ago(s.updatedAt)}` : who.name}
                className={cx("inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-xs ring-1",
                  s.status === "completed" ? "bg-green-500/10 text-green-200 ring-green-500/30"
                    : s.status && !s.hidden ? "bg-indigo-500/10 text-indigo-200 ring-indigo-500/30" : "bg-gray-800 text-gray-400 ring-gray-700")}>
                <Avatar user={who} className="h-5 w-5 text-[10px]" />
                {memberText(s, m.episodes)}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item.state !== "done" && <Button size="sm" onClick={onTogether}><UsersIcon className="h-4 w-4" />Посмотрели вместе</Button>}
          <span className="text-xs text-gray-500">добавил{name(item.addedBy) ? ` ${name(item.addedBy)}` : "и"} {ago(item.addedAt)}</span>
        </div>
      </div>
    </li>
  );
}

/** Окно «Посмотрели вместе» для тайтла из списка (состояние подгружается при открытии). */
function TogetherFor({ media, onClose }: { media: MediaLite; onClose: () => void }) {
  const { data } = useTogether(media.id);
  if (!data) return null;
  return <WatchTogetherDialog media={media} state={data} open onClose={onClose} />;
}

function AddTitle({ listId, onAdded }: { listId: number; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const { data } = useQuery({
    queryKey: ["search", dq], enabled: dq.length >= 2,
    queryFn: () => api<{ media: MediaLite[] }>(`/api/search?q=${encodeURIComponent(dq)}`),
  });
  const add = async (m: MediaLite) => {
    await api(`/api/shared-lists/${listId}/items`, { method: "POST", json: { anilistId: m.id } });
    setQ("");
    onAdded();
  };
  return (
    <div className="relative max-w-md">
      <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Добавить тайтл: название…"
        className="h-9 w-full rounded-lg border border-gray-600 bg-gray-900 pl-9 pr-3 text-sm focus:border-indigo-500 focus:outline-none" />
      {dq.length >= 2 && q && data && (
        <ul className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg bg-gray-800 py-1 shadow-2xl ring-1 ring-gray-600">
          {data.media.length ? data.media.map((m) => (
            <li key={m.id}>
              <button onClick={() => add(m)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-gray-700">
                <span className="relative h-10 w-7 shrink-0 overflow-hidden rounded">{m.coverImage.large && <Img src={m.coverImage.large} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}</span>
                <span className="min-w-0 flex-1 truncate">{displayTitle(m.title)}</span>
                <span className="text-xs text-gray-500">{m.seasonYear}</span>
              </button>
            </li>
          )) : <li className="px-3 py-2 text-sm text-gray-500">Ничего не нашлось</li>}
        </ul>
      )}
    </div>
  );
}

/** Заглушка общего списка: переключатель и вкладки живые, название, участники и строки тайтлов — по форме настоящих. */
function SharedListSkeleton({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div className="space-y-6" aria-busy>
      <GroupsTitle back />
      <div className="flex flex-wrap items-center gap-3">
        <Skel className="h-8 w-56" />
        <Skel className="ml-auto h-8 w-32 rounded-lg" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {[0, 1, 2].map((i) => <Skel key={i} className="h-8 w-28 rounded-full" />)}
      </div>
      <Skel className="h-9 w-full max-w-md rounded-lg" />
      <div className="flex gap-1 overflow-x-auto border-b border-gray-700">
        {TABS.map(([t, text]) => (
          <button key={t} onClick={() => onTab(t)}
            className={cx("-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition",
              tab === t ? "border-indigo-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200")}>
            {text} <span className="inline-flex align-middle"><Skel className="ml-1 h-5 w-7 rounded-full" /></span>
          </button>
        ))}
      </div>
      <ul className="grid gap-3 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="flex gap-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
            <Skel className="aspect-2/3 w-16 shrink-0 rounded-lg sm:w-20" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skel className="h-5 w-2/3" />
              <div className="flex gap-1.5"><Skel className="h-6 w-16 rounded-full" /><Skel className="h-6 w-16 rounded-full" /></div>
              <div className="flex items-center gap-2"><Skel className="h-7 w-40 rounded-lg" /><Skel className="h-3 w-24" /></div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SharedListView({ id }: { id: number }) {
  const { data: list, isLoading, error } = useSharedList(id);
  const { data: me } = useMe();
  const { data: people } = usePeople();
  const { params, setParams } = useUrlState();
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();
  const [together, setTogether] = useState<MediaLite | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);

  if (isLoading) return <SharedListSkeleton tab={(params.get("tab") as Tab) || "watching"} onTab={(t) => setParams({ tab: t })} />;
  if (error || !list) return <ErrorBox error={error} />;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["shared-list", id] });
    void qc.invalidateQueries({ queryKey: ["shared-lists"] });
  };
  const action = async (body: { action: string; userId?: number }) => {
    await api(`/api/shared-lists/${id}`, { method: "POST", json: body });
    if (body.action === "leave" || body.action === "decline") { router.push("/groups"); return; }
    refresh();
  };
  const owner = list.role === "owner";
  const friendsOut = (people ?? []).filter((p) => p.state === "friends" && !list.members.some((m) => m.id === p.id));
  const counts = Object.fromEntries(TABS.map(([t]) => [t, list.items.filter((i) => i.state === t).length])) as Record<Tab, number>;
  const tab = (params.get("tab") as Tab) || (counts.watching ? "watching" : counts.planned ? "planned" : "watching");
  const items = list.items.filter((i) => i.state === tab);

  return (
    <div className="space-y-6">
      <GroupsTitle back />
      <div className="flex flex-wrap items-center gap-3">
        {rename !== null ? (
          <form className="flex gap-2" onSubmit={async (e) => {
            e.preventDefault();
            await api(`/api/shared-lists/${id}`, { method: "PATCH", json: { name: rename } });
            setRename(null);
            refresh();
          }}>
            <input value={rename} onChange={(e) => setRename(e.target.value)} autoFocus
              className="h-10 rounded-lg border border-gray-600 bg-gray-900 px-3 text-lg font-bold focus:border-indigo-500 focus:outline-none" />
            <Button type="submit" variant="primary">Сохранить</Button>
          </form>
        ) : (
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            {list.name}
            {owner && <button onClick={() => setRename(list.name)} title="Переименовать" className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-white"><PencilIcon className="h-4 w-4" /></button>}
          </h2>
        )}
        <div className="ml-auto flex gap-2">
          {owner ? (
            <Button size="sm" variant="ghost" onClick={async () => {
              if (!(await confirm({ title: `Удалить группу «${list.name}»?`, text: "Он исчезнет у всех участников. Личные списки не изменятся.", confirm: "Удалить", danger: true }))) return;
              await api(`/api/shared-lists/${id}`, { method: "DELETE" });
              router.push("/groups");
            }}>Удалить группу</Button>
          ) : list.role === "member" && <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: `Покинуть «${list.name}»?`, text: "Вернуться можно будет только по новому приглашению.", confirm: "Покинуть", danger: true })) void action({ action: "leave" }); }}>Покинуть</Button>}
        </div>
      </div>

      {/* Участники */}
      <div className="flex flex-wrap items-center gap-2">
        {list.members.map((m) => (
          <span key={m.id} className={cx("inline-flex items-center gap-2 rounded-full bg-gray-800 py-1 pl-1 pr-3 text-sm ring-1 ring-gray-700", m.status === "invited" && "opacity-60")}>
            <Avatar user={m} className="h-6 w-6 text-xs" />
            <Link href={`/users/${m.id}`} className="hover:text-indigo-300">{m.id === me?.id ? "Вы" : m.name}</Link>
            {m.status === "invited" && <span className="text-xs text-gray-400">приглашён</span>}
            {owner && m.id !== me?.id && (
              <button onClick={async () => { if (await confirm({ title: `Убрать ${m.name} из группы?`, confirm: "Убрать", danger: true })) void action({ action: "remove", userId: m.id }); }} className="text-gray-500 hover:text-white" aria-label="Убрать">
                <XMarkIcon className="h-4 w-4" />
              </button>
            )}
          </span>
        ))}
        {list.role !== "invited" && friendsOut.length > 0 && (
          <div className="relative">
            <Button size="sm" variant="ghost" onClick={() => setInvite(!invite)}><UserPlusIcon className="h-4 w-4" />Пригласить</Button>
            {invite && (
              <div className="mobile-popover absolute left-0 top-full z-30 mt-1 w-56 rounded-lg bg-gray-800 py-1 shadow-2xl ring-1 ring-gray-600" onMouseLeave={() => setInvite(false)}>
                {friendsOut.map((f) => (
                  <button key={f.id} onClick={() => { setInvite(false); void action({ action: "invite", userId: f.id }); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-700">
                    <Avatar user={f} className="h-6 w-6 text-xs" />{f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {list.role === "invited" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-indigo-500/10 p-4 ring-1 ring-indigo-500/30">
          <span>Вас пригласили в эту группу.</span>
          <Button variant="primary" size="sm" onClick={() => action({ action: "accept" })}>Присоединиться</Button>
          <Button size="sm" onClick={() => action({ action: "decline" })}>Отклонить</Button>
        </div>
      ) : (
        <>
          <GroupPlan list={list} />
          <AddTitle listId={id} onAdded={refresh} />
          <div className="flex gap-1 overflow-x-auto border-b border-gray-700">
            {TABS.map(([t, text]) => (
              <button key={t} onClick={() => setParams({ tab: t })}
                className={cx("-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition",
                  tab === t ? "border-indigo-500 text-white" : "border-transparent text-gray-400 hover:text-gray-200")}>
                {text} <span className="ml-1 rounded-full bg-gray-700 px-2 py-0.5 text-xs">{counts[t]}</span>
              </button>
            ))}
          </div>
          {items.length ? (
            <ul className="grid gap-3 xl:grid-cols-2">
              {items.map((i) => (
                <ItemRow key={i.media.id} item={i} list={list} onTogether={() => setTogether(i.media)}
                  onRemove={async () => { await api(`/api/shared-lists/${id}/items?anilistId=${i.media.id}`, { method: "DELETE" }); refresh(); }} />
              ))}
            </ul>
          ) : (
            <EmptyState title="Здесь пока пусто">
              {tab === "planned" ? "Добавьте тайтл поиском выше или кнопкой «В общий список» на странице тайтла." : tab === "watching" ? "Начатое кем-то из участников появится здесь." : "Тайтлы, которые досмотрели все, — здесь."}
            </EmptyState>
          )}
        </>
      )}
      {together && <TogetherFor media={together} onClose={() => { setTogether(null); refresh(); }} />}
    </div>
  );
}
