"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LinkIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { INVITE_STATE_LABEL, type InviteView } from "@/lib/accounts";
import { api, useSharedLists } from "@/lib/client";
import { formatDateTime } from "@/lib/time";
import { Badge, Button, ErrorBox } from "./ui";
import { PrivateLink } from "./PrivateLink";

const STATE_TONE = { active: "accent", pending: "warning", used: "positive", expired: "neutral", revoked: "neutral" } as const;

export function InviteRow({ inv, onRevoke, from, busy = false }: { inv: InviteView; onRevoke?: () => void; from?: boolean; busy?: boolean }) {
  const active = inv.state === "active";
  return <li className="space-y-3 rounded-xl bg-gray-800/50 p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1.5"><div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATE_TONE[inv.state]}>{INVITE_STATE_LABEL[inv.state]}</Badge>
        {inv.note && <span className="break-words font-medium">{inv.note}</span>}
        {inv.group && <span className="break-words text-gray-400">в группу «{inv.group}»</span>}
      </div><p className="text-xs leading-relaxed text-gray-400">
        {from && <span>Создал {inv.inviter.name} · </span>}
        {inv.state === "used" ? `Использовано${inv.usedBy ? ` · ${inv.usedBy.name}` : ""}${inv.usedAt ? ` · ${formatDateTime(inv.usedAt)}` : ""}` : inv.state === "expired" ? `Срок истёк ${formatDateTime(inv.expiresAt)}` : active ? `Действует до ${formatDateTime(inv.expiresAt)}` : `Создано ${formatDateTime(inv.createdAt)}`}
      </p></div>
      {onRevoke && active && <button type="button" disabled={busy} onClick={onRevoke} aria-label={`Отозвать приглашение${inv.note ? `: ${inv.note}` : ""}`} title="Отозвать приглашение" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-700 hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-accent-300 disabled:opacity-40"><XMarkIcon className="h-4 w-4"/></button>}
    </div>
    {active && (inv.canCopy || inv.link) && <PrivateLink url={inv.link} load={inv.canCopy ? async () => (await api<{link:string}>(`/api/invites/${inv.id}/copy`, {method:"POST"})).link : undefined}/>}
    {active && !inv.canCopy && !inv.link && <p className="text-xs text-gray-400">Старая ссылка хранится только как хеш. Для повторного копирования создайте новое приглашение.</p>}
  </li>;
}

export function InvitePanel() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["invites"], queryFn: () => api<{enabled:boolean;invites:InviteView[]}>("/api/invites"), refetchInterval: 5000 });
  const { data: groups } = useSharedLists();
  const [note, setNote] = useState(""), [created, setCreated] = useState<InviteView|null>(null), [hours, setHours] = useState(168), [groupId, setGroupId] = useState<number|"">("");
  const [busy, setBusy] = useState(false), [err, setErr] = useState<unknown>(null);
  if (!data?.enabled) return error ? <ErrorBox error={error}/> : null;
  const mine = (groups ?? []).filter(g => g.role !== "invited");
  const invites = data.invites.map(inv => inv.id === created?.id && inv.state === "active" ? {...inv, link:created.link} : inv);
  if (created && !invites.some(inv => inv.id === created.id)) invites.unshift(created);
  const input = "h-9 w-full min-w-0 rounded-lg bg-gray-900 px-3 text-sm ring-1 ring-gray-600 focus:outline-none focus:ring-2 focus:ring-accent-300";
  const revoke = async (id:string) => {
    setBusy(true); setErr(null);
    try { await api(`/api/invites/${id}`, {method:"DELETE"}); await qc.invalidateQueries({queryKey:["invites"]}); if (created?.id === id) setCreated(null); }
    catch(e) {setErr(e);} finally {setBusy(false);}
  };
  return <section className="space-y-4" aria-label="Приглашения">
    <div className="max-w-2xl space-y-2"><h2 className="text-lg font-semibold">Пригласить в кинотеатр</h2><p className="text-sm leading-relaxed text-gray-400">Одноразовая ссылка открывает доступ после регистрации. Пока приглашение действует, полную ссылку можно скопировать повторно; на экране её секретная часть скрыта.</p></div>
    <form className="grid items-end gap-3 sm:grid-cols-2" onSubmit={async e => {
      e.preventDefault(); if(busy) return; setBusy(true); setErr(null);
      try { setCreated(await api<InviteView>("/api/invites", {method:"POST",json:{note,hours,groupId:groupId||undefined}})); setNote(""); await qc.invalidateQueries({queryKey:["invites"]}); }
      catch(e) {setErr(e);} finally {setBusy(false);}
    }}>
      <label className="min-w-0 space-y-1.5 text-xs text-gray-400"><span>Для кого</span><input className={input} placeholder="Заметка для вас и администратора" value={note} onChange={e=>setNote(e.target.value)} maxLength={60}/></label>
      {mine.length > 0 && <label className="min-w-0 space-y-1.5 text-xs text-gray-400"><span>Комната</span><select className={input} value={groupId} onChange={e=>setGroupId(e.target.value?Number(e.target.value):"")}><option value="">Без комнаты</option>{mine.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>}
      <label className="min-w-0 space-y-1.5 text-xs text-gray-400"><span>Срок действия</span><select className={input} value={hours} onChange={e=>setHours(Number(e.target.value))}><option value={1}>1 час</option><option value={24}>24 часа</option><option value={168}>7 дней</option></select></label>
      <Button type="submit" variant="primary" disabled={busy} className="w-full"><LinkIcon className="h-4 w-4"/>{busy?"Подождите…":"Создать ссылку"}</Button>
    </form>
    {err ? <ErrorBox error={err}/> : null}
    {!!invites.length && <ul className="space-y-3">{invites.map(inv=><InviteRow key={inv.id} inv={inv} busy={busy} onRevoke={()=>void revoke(inv.id)}/>)}</ul>}
  </section>;
}
