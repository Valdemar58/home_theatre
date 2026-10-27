"use client";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, usePeople, useSharedLists } from "@/lib/client";
import type { SharedListSummary } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Img } from "./Img";
import { Button, EmptyState, ErrorBox, Modal, Skel } from "./ui";

// Общие списки: приглашения, мои списки (обложки, участники, сколько смотрим/досмотрели), создание.

export function ListsSwitch({ active }: { active: "mine" | "shared" }) {
  const { data } = useSharedLists();
  const invites = data?.filter((l) => l.role === "invited").length ?? 0;
  const tab = (href: string, on: boolean, text: React.ReactNode) => (
    <Link href={href} className={on ? "text-white" : "text-gray-500 hover:text-gray-300"}>{text}</Link>
  );
  return (
    <h1 className="mb-5 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-2xl font-bold sm:text-3xl">
      {tab("/lists", active === "mine", "Мои списки")}
      {tab("/lists/shared", active === "shared", <>Общие{invites > 0 && <span className="ml-1.5 rounded-full bg-indigo-500 px-2 py-0.5 align-middle text-xs text-white">{invites}</span>}</>)}
    </h1>
  );
}

export function CreateListModal({ open, onClose, withTitle }: { open: boolean; onClose: () => void; withTitle?: number }) {
  const { data: people } = usePeople();
  const friends = (people ?? []).filter((p) => p.state === "friends");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api<{ id: number }>("/api/shared-lists", { method: "POST", json: { name, invite: [...picked] } });
      if (withTitle) await api(`/api/shared-lists/${id}/items`, { method: "POST", json: { anilistId: withTitle } });
      router.push(`/lists/shared/${id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Новый общий список">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Например: «Смотрим с Петей»"
          className="h-10 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm focus:border-indigo-500 focus:outline-none" />
        <div>
          <p className="mb-1.5 text-sm text-gray-400">Пригласить друзей</p>
          {friends.length ? (
            <ul className="space-y-1">
              {friends.map((f) => (
                <li key={f.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-gray-700/40">
                    <input type="checkbox" checked={picked.has(f.id)} className="h-4 w-4 accent-indigo-500"
                      onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
                    <Avatar user={f} /><span className="text-sm">{f.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-gray-500">Друзей пока нет — <Link href="/friends" className="text-indigo-300 underline">добавьте</Link>, пригласить можно и позже.</p>}
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Создать</Button>
        </div>
      </form>
    </Modal>
  );
}

function ListCard({ l }: { l: SharedListSummary }) {
  const qc = useQueryClient();
  const respond = async (action: "accept" | "decline") => {
    await api(`/api/shared-lists/${l.id}`, { method: "POST", json: { action } });
    void qc.invalidateQueries({ queryKey: ["shared-lists"] });
  };
  const members = l.members.filter((m) => m.status === "member");
  const body = (
    <>
      <div className="grid aspect-[16/9] grid-cols-4 overflow-hidden rounded-t-xl bg-gray-800">
        {l.covers.map((c) => <Img key={c} src={c} size="thumb" className="h-full w-full object-cover" />)}
      </div>
      <div className="space-y-2 p-3">
        <p className="truncate font-semibold">{l.name}</p>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">{members.slice(0, 5).map((m) => <Avatar key={m.id} user={m} className="h-7 w-7 text-xs ring-2 ring-gray-900" />)}</div>
          <span className="truncate text-xs text-gray-400">{members.map((m) => m.name).join(", ")}</span>
        </div>
        <p className="text-xs text-gray-400">
          {l.counts.total} тайтлов{l.counts.watching > 0 && ` · смотрим ${l.counts.watching}`}{l.counts.done > 0 && ` · досмотрели ${l.counts.done}`}
        </p>
      </div>
    </>
  );
  if (l.role === "invited") return (
    <div className="overflow-hidden rounded-xl bg-gray-800/60 ring-1 ring-indigo-500/50">
      {body}
      <div className="flex gap-2 px-3 pb-3">
        <Button size="sm" variant="primary" onClick={() => respond("accept")}>Присоединиться</Button>
        <Button size="sm" onClick={() => respond("decline")}>Отклонить</Button>
      </div>
    </div>
  );
  return <Link href={`/lists/shared/${l.id}`} className="block overflow-hidden rounded-xl bg-gray-800/60 ring-1 ring-gray-700 transition hover:ring-gray-500">{body}</Link>;
}

export function SharedListsView() {
  const { data, isLoading, error } = useSharedLists();
  const params = useSearchParams();
  const withTitle = Number(params.get("create")) || undefined;
  const [create, setCreate] = useState(false);
  useEffect(() => { if (withTitle) setCreate(true); }, [withTitle]);
  if (error) return <ErrorBox error={error} />;
  const lists = data ?? [];
  const invites = lists.filter((l) => l.role === "invited");
  const mine = lists.filter((l) => l.role !== "invited");
  return (
    <div>
      <ListsSwitch active="shared" />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <p className="text-sm text-gray-400">Списки на нескольких: видно, кто что смотрел, «Посмотрели вместе» отмечает серии сразу всем.</p>
        <Button variant="primary" className="ml-auto" onClick={() => setCreate(true)}><PlusIcon className="h-4 w-4" />Создать</Button>
      </div>
      {isLoading && (
        // Карточки-заглушки той же формы: обложки 16:9, название, участники, счётчики
        <div aria-busy className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-xl bg-gray-800/60 ring-1 ring-gray-700">
              <Skel className="aspect-video w-full rounded-none rounded-t-xl" />
              <div className="space-y-2 p-3">
                <Skel className="h-5 w-2/3" />
                <div className="flex items-center gap-2"><Skel className="h-7 w-16 rounded-full" /><Skel className="h-3 w-24" /></div>
                <Skel className="h-3 w-32" />
              </div>
            </div>
          ))}
        </div>
      )}
      {invites.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Приглашения</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{invites.map((l) => <ListCard key={l.id} l={l} />)}</div>
        </section>
      )}
      {mine.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{mine.map((l) => <ListCard key={l.id} l={l} />)}</div>
      ) : !invites.length && !isLoading && (
        <EmptyState title="Общих списков пока нет">Создайте список и пригласите друзей — добавлять тайтлы можно отсюда и со страницы тайтла.</EmptyState>
      )}
      <CreateListModal open={create} onClose={() => setCreate(false)} withTitle={withTitle} />
    </div>
  );
}
