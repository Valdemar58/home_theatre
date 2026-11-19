"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { Account, AccountsView as View } from "@/lib/accounts";
import { api, useMe } from "@/lib/client";
import { formatDate, formatDateTime } from "@/lib/time";
import { Avatar } from "./Avatar";
import { useAlert, useConfirm } from "./Dialogs";
import { InviteRow } from "./InvitePanel";
import { Badge, Button, EmptyState, ErrorBox, Skel } from "./ui";

type Act = "admin" | "friend" | "block" | "unblock" | "libraries-on" | "libraries-off" | "reset" | "delete";

function AccountRow({ a, self, onAct }: { a: Account; self: boolean; onAct: (a: Account, act: Act) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = (act: Act) => async () => {
    setBusy(true);
    await onAct(a, act).finally(() => setBusy(false));
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <Link href={`/users/${a.id}`}><Avatar user={a} className="h-10 w-10" /></Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/users/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
          {a.admin && <Badge tone="special">админ</Badge>}
          {a.blocked && <Badge tone="negative">заблокирован</Badge>}
          {!a.linked && !a.blocked && <Badge tone="warning" variant="outline">не входил через единый вход</Badge>}
        </div>
        <p className="truncate text-xs text-gray-400">
          {[a.email, a.invitedBy && `пригласил(а) ${a.invitedBy.name}`, a.lastLogin ? `вход ${formatDateTime(a.lastLogin)}` : `с ${formatDate(a.createdAt)}`]
            .filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {a.libraries !== null && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={run(a.libraries ? "libraries-off" : "libraries-on")}
            title="Доступ к библиотекам в Jellyfin (ТВ и приложения). В календаре смотреть можно и без него">
            {a.libraries ? <CheckIcon className="h-4 w-4 text-positive-300" /> : <XMarkIcon className="h-4 w-4" />}Jellyfin
          </Button>
        )}
        {a.linked && !a.blocked && !self && <Button size="sm" disabled={busy} onClick={run(a.admin ? "friend" : "admin")}>{a.admin ? "Снять админа" : "Сделать админом"}</Button>}
        {a.linked && !a.blocked && <Button size="sm" disabled={busy} onClick={run("reset")}>Сброс пароля</Button>}
        {!self && (
          <Button size="sm" variant={a.blocked ? "default" : "ghost"} disabled={busy} onClick={run(a.blocked ? "unblock" : "block")}>
            {a.blocked ? "Разблокировать" : "Заблокировать"}
          </Button>
        )}
        {a.linked && !self && <Button size="sm" variant="danger" disabled={busy} onClick={run("delete")}>Удалить</Button>}
      </div>
    </li>
  );
}

export function AccountsView() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const confirm = useConfirm();
  const alert = useAlert();
  const { data, error, isLoading } = useQuery({ queryKey: ["accounts"], queryFn: () => api<View>("/api/accounts"), refetchInterval: 60_000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["accounts"] });

  const act = async (a: Account, action: Act) => {
    const ask: Partial<Record<Act, { title: string; text: string; confirm: string }>> = {
      block: { title: `Заблокировать ${a.name}?`, text: "Выйдет из календаря сразу, не войдёт ни в один сервис и в Jellyfin. Данные и списки останутся.", confirm: "Заблокировать" },
      delete: { title: `Удалить учётку ${a.name}?`, text: "Учётки входа и Jellyfin удаляются. В календаре человек останется заблокированным: комментарии и история не пропадут.", confirm: "Удалить" },
      admin: { title: `Сделать ${a.name} админом?`, text: "Админ видит загрузки и служебные сервисы, одобряет заявки и управляет пользователями.", confirm: "Сделать админом" },
    };
    const q = ask[action];
    if (q && !(await confirm({ ...q, danger: action !== "admin" }))) return;
    try {
      const res = await api<{ link?: string }>(`/api/accounts/${a.id}`, { method: "POST", json: { action } });
      if (res.link) alert({
        title: `Ссылка для нового пароля ${a.name}`,
        text: <span className="block space-y-2"><span className="block">Отправьте её человеку: по ней он задаст новый пароль и сразу войдёт.</span>
          <input readOnly value={res.link} onFocus={(e) => e.target.select()} className="w-full rounded-md bg-gray-900 px-2 py-1 font-mono text-xs ring-1 ring-gray-700" /></span>,
      });
    } catch (e) {
      alert({ title: "Не получилось", text: e instanceof Error ? e.message : String(e) });
    }
    refresh();
  };
  const decide = async (pk: number, approve: boolean, name: string) => {
    if (!approve && !(await confirm({ title: `Отклонить заявку ${name}?`, text: "Учётка будет удалена, ссылка-приглашение перестанет работать.", confirm: "Отклонить", danger: true }))) return;
    try {
      await api(`/api/accounts/requests/${pk}`, { method: "POST", json: { approve } });
    } catch (e) {
      alert({ title: "Не получилось", text: e instanceof Error ? e.message : String(e) });
    }
    refresh();
  };

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="max-w-4xl space-y-3" aria-busy><Skel className="h-9 w-56" />{[0, 1, 2].map((i) => <Skel key={i} className="h-16" />)}</div>;
  const active = data.accounts.filter((a) => !a.blocked);
  const blocked = data.accounts.filter((a) => a.blocked);

  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-2xl font-bold sm:text-3xl">Пользователи</h1>
      {!data.sso && (
        <EmptyState title="Единый вход не настроен">
          Запустите профиль <code>public</code> и <code>python scripts/bootstrap.py --only authentik</code>: появятся приглашения и заявки.
        </EmptyState>
      )}
      {data.requests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Заявки <span className="text-sm font-normal text-gray-500">{data.requests.length}</span></h2>
          <ul className="space-y-2">
            {data.requests.map((r) => (
              <li key={r.authPk} className="flex flex-wrap items-center gap-3 rounded-xl p-3 tone-warning soft">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.username}</p>
                  <p className="text-xs opacity-80">{[r.email, r.inviter ? `по приглашению ${r.inviter.name}` : "без приглашения", formatDateTime(r.createdAt)].filter(Boolean).join(" · ")}</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => void decide(r.authPk, true, r.username)}><CheckIcon className="h-4 w-4" />Одобрить</Button>
                <Button size="sm" onClick={() => void decide(r.authPk, false, r.username)}>Отклонить</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Пользователи <span className="text-sm font-normal text-gray-500">{active.length}</span></h2>
        <ul className="space-y-2">{active.map((a) => <AccountRow key={a.id} a={a} self={a.id === me?.id} onAct={act} />)}</ul>
      </section>
      {data.invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Действующие приглашения <span className="text-sm font-normal text-gray-500">{data.invites.length}</span></h2>
          <ul className="space-y-2">
            {data.invites.map((inv) => (
              <InviteRow key={inv.id} inv={inv} from onRevoke={async () => { await api(`/api/invites/${inv.id}`, { method: "DELETE" }); refresh(); }} />
            ))}
          </ul>
          <p className="text-xs text-gray-500">Своё приглашение — на странице <Link href="/friends" className="underline">«Друзья»</Link>.</p>
        </section>
      )}
      {blocked.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Заблокированные <span className="text-sm font-normal text-gray-500">{blocked.length}</span></h2>
          <ul className="space-y-2">{blocked.map((a) => <AccountRow key={a.id} a={a} self={a.id === me?.id} onAct={act} />)}</ul>
        </section>
      )}
    </div>
  );
}
