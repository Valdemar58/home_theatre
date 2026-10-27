"use client";
import { CheckIcon, UserPlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api, usePeople } from "@/lib/client";
import type { FriendState } from "@/lib/social-rules";
import type { Person } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Button, EmptyState, ErrorBox, Skel } from "./ui";
import { useConfirm } from "./Dialogs";

// Друзья: входящие заявки, друзья (с совпадением вкусов), отправленные, остальные пользователи сервера.

type Action = "request" | "accept" | "decline" | "cancel" | "remove";

export function useFriendAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, action }: { userId: number; action: Action }) =>
      api<Person[]>("/api/friends", { method: "POST", json: { userId, action } }),
    onSuccess: (people, { userId }) => {
      qc.setQueryData(["people"], people);
      void qc.invalidateQueries({ queryKey: ["profile", userId] });
      void qc.invalidateQueries({ queryKey: ["user-list", userId] });
    },
  });
}

/** Кнопки дружбы по текущему состоянию. */
export function FriendButtons({ userId, state, name }: { userId: number; state: FriendState; name: string }) {
  const act = useFriendAction();
  const confirm = useConfirm();
  const run = (action: Action) => act.mutate({ userId, action });
  const busy = act.isPending;
  if (state === "incoming") return (
    <div className="flex gap-2">
      <Button variant="primary" size="sm" disabled={busy} onClick={() => run("accept")}><CheckIcon className="h-4 w-4" />Принять</Button>
      <Button size="sm" disabled={busy} onClick={() => run("decline")}>Отклонить</Button>
    </div>
  );
  if (state === "outgoing") return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => run("cancel")} title="Отменить заявку">
      Заявка отправлена <XMarkIcon className="h-4 w-4" />
    </Button>
  );
  if (state === "friends") return (
    <Button size="sm" variant="ghost" disabled={busy}
      onClick={async () => { if (await confirm({ title: `Удалить ${name} из друзей?`, text: "Вы перестанете видеть профили друг друга (если они открыты только друзьям).", confirm: "Удалить", danger: true })) run("remove"); }}>
      <CheckIcon className="h-4 w-4 text-green-400" />В друзьях
    </Button>
  );
  return <Button size="sm" disabled={busy} onClick={() => run("request")}><UserPlusIcon className="h-4 w-4" />Добавить в друзья</Button>;
}

function PersonRow({ p }: { p: Person }) {
  const name = p.visible ? (
    <Link href={`/users/${p.id}`} className="truncate font-medium hover:text-indigo-300">{p.name}</Link>
  ) : <span className="truncate font-medium">{p.name}</span>;
  return (
    <li className="flex items-center gap-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      {p.visible ? <Link href={`/users/${p.id}`}><Avatar user={p} className="h-11 w-11 text-lg" /></Link> : <Avatar user={p} className="h-11 w-11 text-lg" />}
      <div className="min-w-0 flex-1">
        {name}
        <p className="text-xs text-gray-400">
          {p.taste !== null ? <>вкусы совпадают на <b className="text-gray-200">{p.taste}%</b></> : p.visible ? "профиль открыт" : "профиль скрыт"}
        </p>
      </div>
      <FriendButtons userId={p.id} state={p.state} name={p.name} />
    </li>
  );
}

function Section({ title, people, hint }: { title: string; people: Person[]; hint?: string }) {
  if (!people.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{title} <span className="text-sm font-normal text-gray-500">{people.length}</span></h2>
      {hint && <p className="mb-3 text-sm text-gray-400">{hint}</p>}
      <ul className="grid gap-2 md:grid-cols-2">{people.map((p) => <PersonRow key={p.id} p={p} />)}</ul>
    </section>
  );
}

export function FriendsView() {
  const { data, isLoading, error } = usePeople();
  if (error) return <ErrorBox error={error} />;
  if (isLoading) return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-2xl font-bold sm:text-3xl">Друзья</h1>
      {/* Какие разделы будут — зависит от данных, поэтому один раздел-заглушка со строками людей */}
      <section aria-busy>
        <Skel className="mb-2 h-7 w-40" />
        <ul className="grid gap-2 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
              <Skel className="h-11 w-11 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5"><Skel className="h-4 w-28" /><Skel className="h-3 w-40" /></div>
              <Skel className="h-8 w-36 shrink-0 rounded-lg" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
  const all = data ?? [];
  const by = (s: FriendState) => all.filter((p) => p.state === s);
  const friends = by("friends").sort((a, b) => (b.taste ?? -1) - (a.taste ?? -1));
  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-2xl font-bold sm:text-3xl">Друзья</h1>
      {!all.length && (
        <EmptyState title="На сервере пока только вы">
          Друзья появятся здесь, когда войдут со своим аккаунтом Jellyfin (аккаунты заводит администратор Jellyfin).
        </EmptyState>
      )}
      <Section title="Заявки в друзья" people={by("incoming")} />
      <Section title="Друзья" people={friends} />
      <Section title="Отправленные заявки" people={by("outgoing")} />
      <Section title="Другие пользователи сервера" people={by("none")}
        hint="Друзья видят профиль и списки друг друга (если не выбрано «Только я»), могут смотреть вместе и вести общие списки." />
    </div>
  );
}
