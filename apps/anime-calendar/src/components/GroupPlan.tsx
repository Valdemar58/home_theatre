"use client";
import { RoomHosts } from "./RoomHosts";
import { MeetingHistory } from "./MeetingHistory";
import { AdjustmentsHorizontalIcon, ArrowDownIcon, ArrowUpIcon, CalendarDaysIcon, CheckIcon, ChartBarIcon, QueueListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, useMe } from "@/lib/client";
import { GROUP_CAPABILITIES, type GroupPermissions } from "@/lib/group-policy";
import { sessionEps, type GroupPlan as Plan, type GroupSession, type Rsvp } from "@/lib/groups";
import { displayTitle } from "@/lib/schedule";
import { formatAiring, relative } from "@/lib/time";
import type { MediaLite, SharedListDetail } from "@/lib/types";
import { SessionEditor } from "./SessionEditor";
import { episodeLabel, legacyBlocks, sessionTimeline } from "@/lib/session-plan";
import { Avatar } from "./Avatar";
import { useConfirm } from "./Dialogs";
import { Img } from "./Img";
import { Badge, Button, cx, ErrorBox } from "./ui";

// Группа просмотра (TASKS 9.4в) на странице общего списка: сеансы по расписанию («приду / не приду»), очередь с
// прогрессом и озвучкой группы, голосование, что смотреть, и кто управляет комнатой (пресет и пульт).

const RSVP: [Rsvp, string][] = [["yes", "Приду"], ["maybe", "Может быть"], ["no", "Не приду"]];
const field = "h-9 rounded-lg border border-gray-600 bg-gray-900 px-2 text-sm focus:border-accent-500 focus:outline-none";

export function GroupPlan({ list, children, legacy = false }: { list: SharedListDetail; children?: React.ReactNode; legacy?: boolean }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const key = ["group", list.id];
  const { data: plan, error } = useQuery({ queryKey: key, queryFn: () => api<Plan>(`/api/shared-lists/${list.id}/group`), refetchInterval: 30_000 });
  const [err, setErr] = useState<unknown>(null);
  const act = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      qc.setQueryData(key, await api<Plan>(`/api/shared-lists/${list.id}/group`, { method: "POST", json: body }));
      await qc.invalidateQueries({ queryKey: ["shared-list", list.id] });
    } catch (e) {
      setErr(e);
      return false;
    }
    return true;
  };
  if (error) return <div className="space-y-4"><ErrorBox error={error} />{children}</div>;
  if (!plan || !me) return <div className="space-y-4"><p role="status" className="text-sm text-gray-400">Загружаем план комнаты…</p>{children}</div>;
  const media = new Map(list.items.map((i) => [i.media.id, i.media]));
  const hostSession = plan.sessions.find(s=>s.status==="live") || plan.sessions.filter(s=>s.status==="planned").sort((a,b)=>a.startsAt-b.startsAt)[0];
  const hostTitles = hostSession ? (hostSession.plan?.blocks || legacyBlocks(hostSession)).map(b=>b.anilistId) : [];
  const name = (id: number) => (id === me.id ? "Вы" : list.members.find((m) => m.id === id)?.name ?? "?");
  return (
    <div className="space-y-3">
      {Boolean(err) && <ErrorBox error={err} />}
      <details className="rounded-xl bg-gray-800/40 p-4">
        <summary className="cursor-pointer text-sm font-medium text-gray-300 hover:text-white">Настройки прав комнаты</summary>
        <div className="mt-4"><Control plan={plan} list={list} me={me.id} act={act} /></div>
      </details>
      {legacy ? <div className="grid items-start gap-4 xl:grid-cols-2">
        <Sessions plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
        <Queue plan={plan} list={list} media={media} act={act} />
        <Poll plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
      </div> : <div className="space-y-6">
        <Sessions plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Queue plan={plan} list={list} media={media} act={act} />
          <Poll plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
        </div>
      </div>}
      {children}
      <RoomHosts room={list.id} plannedTitles={hostTitles} watched={Object.fromEntries(plan.queue.map(q=>[q.anilistId,q.watchedEpisodes||[]]))} titles={Object.fromEntries(list.items.map(i=>[i.media.id,displayTitle(i.media.title)]))} />
      <MeetingHistory plan={plan} list={list} />
    </div>
  );
}

type Act = (body: Record<string, unknown>) => Promise<boolean>;

function Card({ icon, title, children, aside }: { icon: React.ReactNode; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl bg-gray-800/40 p-4 ring-1 ring-gray-700">
      <h3 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}<span className="ml-auto text-xs font-normal text-gray-500">{aside}</span></h3>
      {children}
    </section>
  );
}

function Cover({ m, className }: { m: MediaLite | undefined; className?: string }) {
  return (
    <span className={cx("relative block shrink-0 overflow-hidden rounded", className)} style={{ backgroundColor: m?.coverImage.color ?? undefined }}>
      {m?.coverImage.large && <Img src={m.coverImage.large} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}

// ---------------------------------------------------------------- сеансы

function Sessions({ plan, list, media, me, name, act }: { plan: Plan; list: SharedListDetail; media: Map<number, MediaLite>; me: number; name: (id: number) => string; act: Act }) {
  const confirm = useConfirm();
  const [form, setForm] = useState<GroupSession | "new" | null>(null);
  const upcoming = plan.sessions.filter((s) => s.status === "planned" || s.status === "live").sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || a.startsAt - b.startsAt);
  return (
    <Card icon={<CalendarDaysIcon className="h-4 w-4 text-gray-400" />} title="Ближайший сеанс"
      aside={plan.canPlan && !form && <button onClick={() => setForm("new")} className="text-accent-300 hover:text-accent-200">Назначить</button>}>
      {form && <SessionEditor key={form === "new" ? "new" : form.id} session={form === "new" ? undefined : form} plan={plan} list={list} onDone={() => setForm(null)} act={act} />}
      {upcoming.length ? (
        <ul className="space-y-2">
          {upcoming.map((s, index) => (
            <SessionRow compact={index > 0} key={s.id} s={s} m={media.get(s.anilistId)} me={me} name={name} members={list.members.filter((x) => x.status === "member")}
              media={media} onEdit={() => setForm(s)} canCancel={s.status === "planned" && plan.canPlan}
              onRsvp={(answer) => act({ action: "rsvp", sessionId: s.id, answer })}
              onCancel={async () => { if (await confirm({ title: "Отменить сеанс?", text: "Участники получат уведомление.", confirm: "Отменить сеанс", danger: true })) void act({ action: "session-cancel", sessionId: s.id }); }} />
          ))}
        </ul>
      ) : !form && <p className="text-sm text-gray-500">Сеансов не назначено. В назначенное время комната откроется сама, за час до начала серии начнут готовиться.</p>}

    </Card>
  );
}

function SessionRow({ s, m, me, name, members, canCancel, onRsvp, onCancel, onEdit, media, compact = false }: {
  compact?: boolean; onEdit: () => void; media: Map<number, MediaLite>;
  s: GroupSession; m: MediaLite | undefined; me: number; name: (id: number) => string; members: SharedListDetail["members"];
  canCancel: boolean; onRsvp: (a: Rsvp) => void; onCancel: () => void;
}) {
  const blocks = s.plan?.blocks ?? legacyBlocks(s);
  const timeline = sessionTimeline(blocks, s.startsAt, s.plan?.skipCredits ?? false);
  const time = (t: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: s.plan?.timeZone ?? undefined, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(t * 1000);
  const when = formatAiring(s.startsAt);
  const mine = s.rsvp.find((r) => r.userId === me)?.answer;
  const silent = members.filter((u) => !s.rsvp.some((r) => r.userId === u.id));
  return (
    <li className={cx("flex gap-4 rounded-xl bg-gray-900/40", compact ? "p-3" : "flex-wrap p-4 sm:flex-nowrap sm:p-6")}>
      <div className={cx("flex shrink-0 items-start -space-x-8", compact ? "" : "pr-2")} aria-label="Тайтлы сеанса">{blocks.slice(0, 3).map((b, i) => <div key={b.anilistId} style={{ zIndex: 3 - i }} className="ring-2 ring-gray-900"><Cover m={media.get(b.anilistId)} className={compact ? "h-20 w-14" : "h-32 w-22 sm:h-40 sm:w-28"} /></div>)}</div>
      <div className="min-w-0 basis-full space-y-1.5 sm:flex-1 sm:basis-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className={cx("font-semibold leading-snug", compact ? "text-sm" : "text-xl")}>{blocks.length > 1 ? `Вечер из ${blocks.length} тайтлов` : m ? displayTitle(m.title) : "?"}</p>
            <p className="text-xs text-gray-400">{when.weekday}, {when.date}, {when.time} {when.tz} · {relative(s.startsAt)}</p>
          </div>
          {s.status === "live" && s.roomId
            ? <Link href={`/anime/${s.anilistId}/watch/${s.ep}?room=${s.roomId}`}><Badge tone="positive">Присоединиться к просмотру</Badge></Link>
            : canCancel && <button onClick={onCancel} title="Отменить сеанс" className="rounded p-0.5 text-gray-500 hover:bg-gray-700 hover:text-white"><XMarkIcon className="h-4 w-4" /></button>}
        </div>
        <ol className="space-y-2 py-3">{blocks.map((b, i) => <li key={b.anilistId} className="text-sm"><p>{media.get(b.anilistId) ? displayTitle(media.get(b.anilistId)!.title) : `#${b.anilistId}`} · серии {episodeLabel(b.episodes)}</p><p className="text-xs tabular-nums text-gray-400">{time(timeline[i].start)} — {time(timeline[i].end)}{i < blocks.length - 1 && b.breakMinutes > 0 ? ` · перерыв ${b.breakMinutes} мин` : ""}</p></li>)}</ol>
        <p className="text-xs text-gray-400">Окончание ≈ {time(timeline.at(-1)!.end)} · {s.plan?.timeZone ?? when.tz}{s.plan?.skipCredits ? " · без OP/ED (оценка)" : ""}</p>
        {canCancel && <Button size="sm" variant="ghost" onClick={onEdit}>Редактировать сеанс</Button>}
        <AvatarStack members={members.filter(u => s.rsvp.some(r => r.userId === u.id && r.answer === "yes"))} label="Планируют прийти" />
        {s.status === "planned" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {RSVP.map(([a, label]) => {
              const who = s.rsvp.filter((r) => r.answer === a);
              return (
                <button key={a} onClick={() => onRsvp(a)} title={who.map((r) => name(r.userId)).join(", ") || undefined}
                  className={cx("rounded-full px-2.5 py-0.5 text-xs ring-1", mine === a
                    ? a === "yes" ? "tone-positive soft" : a === "no" ? "tone-negative soft" : "tone-warning soft"
                    : "text-gray-300 ring-gray-600 hover:bg-gray-700")}>
                  {label}{who.length ? ` · ${who.length}` : ""}
                </button>
              );
            })}
            {silent.length > 0 && <span className="text-xs text-gray-400">Без ответа: {silent.length}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- очередь

function Queue({ plan, list, media, act }: { plan: Plan; list: SharedListDetail; media: Map<number, MediaLite>; act: Act }) {
  const rest = list.items.filter((i) => i.state !== "done" && !plan.queue.some((q) => q.anilistId === i.media.id));
  return (
    <Card icon={<QueueListIcon className="h-4 w-4 text-gray-400" />} title="Очередь" aside="порядок просмотра">
      {plan.queue.length ? (
        <ol className="space-y-1.5">
          {plan.queue.map((q, k) => {
            const m = media.get(q.anilistId);
            const total = m?.episodes ?? null;
            return (
              <li key={q.anilistId} className={cx("flex items-center gap-2.5 rounded-lg p-1.5", k === 0 && "bg-accent-500/10 ring-1 ring-accent-500/30")}>
                <span className="w-4 text-center text-xs tabular-nums text-gray-500">{k + 1}</span>
                <Cover m={m} className="h-12 w-8" />
                <div className="min-w-0 flex-1">
                  <Link href={`/anime/${q.anilistId}`} className="block truncate text-sm hover:text-accent-200">{m ? displayTitle(m.title) : "?"}</Link>
                  <p className="flex items-center gap-2 text-xs text-gray-400">
                    <span>{q.progress ? `просмотрено ${q.progress}${total ? `/${total}` : ""} серий` : "группа ещё не начала"}</span>
                    <VoiceField disabled={!plan.capabilities.queue} value={q.voice} onSave={(voice) => act({ action: "voice", anilistId: q.anilistId, voice })} />
                  </p>
                </div>
                <span className="flex shrink-0">
                  <IconBtn label="Выше" disabled={!plan.capabilities.reorder || k === 0} onClick={() => act({ action: "queue-move", anilistId: q.anilistId, dir: -1 })}><ArrowUpIcon className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn label="Ниже" disabled={!plan.capabilities.reorder || k === plan.queue.length - 1} onClick={() => act({ action: "queue-move", anilistId: q.anilistId, dir: 1 })}><ArrowDownIcon className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn disabled={!plan.capabilities.queue} label="Убрать из очереди" onClick={() => act({ action: "queue-remove", anilistId: q.anilistId })}><XMarkIcon className="h-3.5 w-3.5" /></IconBtn>
                </span>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-sm text-gray-500">Очередь пуста: добавьте тайтл или запустите голосование.</p>}
      {rest.length > 0 && plan.capabilities.queue && (
        <select value="" onChange={(e) => e.target.value && void act({ action: "queue-add", anilistId: Number(e.target.value) })} className={cx(field, "w-full text-gray-400")}>
          <option value="">+ В очередь…</option>
          {rest.map((i) => <option key={i.media.id} value={i.media.id}>{displayTitle(i.media.title)}</option>)}
        </select>
      )}
    </Card>
  );
}

/** Озвучка группы для тайтла: студия (её звук готовится к сеансу); пусто — у каждого своя. */
function VoiceField({ value, onSave, disabled }: { disabled?: boolean; value: string | null; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  return (
    <input disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if ((v.trim() || null) !== value) onSave(v.trim() || null); }}
      placeholder="озвучка: у каждого своя" title="Озвучка группы: её звук готовится к сеансу вместе с серией"
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-gray-300 placeholder:text-gray-600 hover:border-gray-600 focus:border-accent-500 focus:outline-none" />
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-white disabled:pointer-events-none disabled:opacity-30">{children}</button>
  );
}

// ---------------------------------------------------------------- голосование

function Poll({ plan, list, media, me, name, act }: { plan: Plan; list: SharedListDetail; media: Map<number, MediaLite>; me: number; name: (id: number) => string; act: Act }) {
  const p = plan.poll;
  const open = p && !p.closedAt;
  const [creating, setCreating] = useState(false);
  const candidates = list.items.filter((i) => i.state === "proposed" || i.state === "planned");
  const [pick, setPick] = useState<Set<number>>(() => new Set(candidates.map((i) => i.media.id)));
  const [hours, setHours] = useState(24);
  const max = p ? Math.max(1, ...p.options.map((o) => o.votes.length)) : 1;
  return (
    <Card icon={<ChartBarIcon className="h-4 w-4 text-gray-400" />} title="Что смотрим дальше"
      aside={open ? `ещё ${relative(p.closesAt).replace(/^через /, "")}` : plan.canPoll && !creating && <button onClick={() => setCreating(true)} className="text-accent-300 hover:text-accent-200">Голосование</button>}>
      {p && (
        <ul className="space-y-1.5">
          {p.options.map((o) => {
            const m = media.get(o.anilistId);
            const mine = o.votes.includes(me);
            const won = p.winner === o.anilistId;
            return (
              <li key={o.anilistId}>
                <button disabled={!open || !plan.capabilities.vote} onClick={() => act({ action: "vote", pollId: p.id, anilistId: o.anilistId })}
                  className={cx("relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-sm ring-1",
                    won ? "tone-positive soft" : mine ? "ring-accent-500/60" : "ring-gray-700", open && "hover:bg-gray-700/40")}>
                  <span className="absolute inset-y-0 left-0 bg-accent-500/15" style={{ width: `${(o.votes.length / max) * 100}%` }} />
                  <span className={cx("relative grid h-4 w-4 shrink-0 place-items-center rounded ring-1", mine ? "bg-accent-500 ring-accent-500" : "ring-gray-500")}>
                    {mine && <CheckIcon className="h-3 w-3 text-white" />}
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{m ? displayTitle(m.title) : "?"}</span>
                  <span className="relative flex -space-x-2" title={o.votes.map(name).join(", ") || "Нет голосов"}>{o.votes.slice(0, 3).map(id => { const u = list.members.find(m => m.id === id); return u ? <Avatar key={id} user={u} className="h-6 w-6 text-[10px] ring-2 ring-gray-800" /> : null; })}{o.votes.length > 3 && <span className="grid h-6 w-6 place-items-center rounded-full bg-gray-700 text-[10px]">+{o.votes.length - 3}</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {p && !open && <p className="text-xs text-gray-500">{p.winner ? "Победитель — в очереди." : "Никто не проголосовал."}</p>}
      {open && plan.canPoll && (
        <Button size="sm" variant="ghost" onClick={() => act({ action: "poll-close", pollId: p.id })}>Подвести итог сейчас</Button>
      )}
      {!p && !creating && <p className="text-sm text-gray-500">Голосования нет. Голосовать можно за несколько тайтлов; победитель встаёт в очередь.</p>}
      {creating && (
        <div className="space-y-2 rounded-lg bg-gray-900/40 p-3">
          {candidates.length < 2 ? <p className="text-sm text-gray-500">Нужно хотя бы два тайтла «в планах».</p> : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {candidates.map((i) => (
                <label key={i.media.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-gray-700/40">
                  <input type="checkbox" className="accent-accent-500" checked={pick.has(i.media.id)}
                    onChange={() => setPick((s) => { const n = new Set(s); if (n.has(i.media.id)) n.delete(i.media.id); else n.add(i.media.id); return n; })} />
                  <span className="truncate">{displayTitle(i.media.title)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className={field}>
              {[[1, "1 час"], [3, "3 часа"], [24, "сутки"], [72, "3 дня"]].map(([h, l]) => <option key={h} value={h}>{l}</option>)}
            </select>
            <Button size="sm" variant="primary" disabled={pick.size < 2} onClick={async () => { if (await act({ action: "poll-create", options: [...pick], hours })) setCreating(false); }}>Запустить</Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Отмена</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- управление

const PERMISSION_LABELS: Record<keyof GroupPermissions, string> = {
  suggest: "Предлагать аниме", queue: "Добавлять и убирать из очереди", reorder: "Менять порядок",
  vote: "Голосовать", schedule: "Назначать и отменять сеансы", play: "Управлять воспроизведением",
  host: "Предоставлять свои файлы", invite: "Приглашать участников",
};
function Control({ plan, list, me, act }: { plan: Plan; list: SharedListDetail; me: number; act: Act }) {
  const [draft, setDraft] = useState<GroupPermissions | null>(null);
  const [saving, setSaving] = useState(false);
  const owner = list.ownerId === me;
  return <div className="space-y-4">
    {plan.legacyPermissions && <p className="text-sm text-gray-400">Сейчас действуют прежние права комнаты. Сохраните настройки, чтобы перейти к отдельным разрешениям.</p>}
    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {GROUP_CAPABILITIES.map(key => <label key={key} className="flex items-center justify-between gap-3 text-sm">
        <span>{PERMISSION_LABELS[key]}{key === "host" && <span className="block text-xs text-gray-400">Раздача только с разрешения владельца устройства</span>}</span>
        <select aria-label={PERMISSION_LABELS[key]} className={field} disabled={!owner || saving} value={(draft ?? plan.permissions)[key]} onChange={e => setDraft({ ...(draft ?? plan.permissions), [key]: e.target.value as "all" | "owner" })}>
          <option value="all">Все участники</option><option value="owner">Организатор</option>
        </select>
      </label>)}
    </div>
    {plan.legacyPermissions && owner && <details><summary className="cursor-pointer text-sm text-gray-400">Прежний пресет и персональные пульты</summary>
      <div className="mt-3 space-y-2"><div className="flex gap-2">{(["equal", "host"] as const).map(preset => <Button key={preset} size="sm" disabled={plan.preset === preset} onClick={() => act({ action: "preset", preset })}>{preset === "equal" ? "Все управляют" : "Организатор"}</Button>)}</div>
      {plan.preset === "host" && list.members.filter(m => m.status === "member" && m.id !== list.ownerId).map(m => <div key={m.id} className="flex items-center gap-2"><Avatar user={m} className="h-6 w-6 text-xs" /><span className="flex-1 text-sm">{m.name}</span><Button size="sm" onClick={() => act({ action: "grant", userId: m.id, control: !plan.control.includes(m.id) })}>{plan.control.includes(m.id) ? "Забрать пульт" : "Дать пульт"}</Button></div>)}</div>
    </details>}
    <p className="text-xs text-gray-400">Создание и завершение голосований, изменение прав — у организатора. Разрешение хостинга не включает раздачу чужих файлов.</p>
    {owner && <Button size="sm" disabled={saving} onClick={async () => { setSaving(true); try { if (await act({ action: "permissions", permissions: draft ?? plan.permissions })) setDraft(null); } finally { setSaving(false); } }}>{saving ? "Сохраняем…" : "Сохранить права"}</Button>}
  </div>;
}

export function AvatarStack({ members, label }: { members: SharedListDetail["members"]; label: string }) {
  if (!members.length) return null;
  return <details className="group relative w-fit">
    <summary aria-label={label} className="flex cursor-pointer list-none items-center -space-x-2 rounded-full focus-visible:outline-2 focus-visible:outline-accent-400">
      {members.slice(0, 4).map(u => <Avatar key={u.id} user={u} className="h-8 w-8 text-xs ring-2 ring-gray-900" />)}
      {members.length > 4 && <span className="grid h-8 w-8 place-items-center rounded-full bg-gray-700 text-xs ring-2 ring-gray-900">+{members.length - 4}</span>}
      <span className="sr-only">{label}: {members.map(m => m.name).join(", ")}</span>
    </summary>
    <div className="absolute left-0 top-full z-30 mt-2 w-64 max-w-[80vw] rounded-xl bg-gray-800 p-3 shadow-xl">
      <p className="mb-2 text-xs text-gray-400">{label}</p>
      {members.map(u => <Link key={u.id} href={`/users/${u.id}`} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-700"><Avatar user={u} className="h-6 w-6 text-xs" /><span className="truncate text-sm">{u.name}</span></Link>)}
    </div>
  </details>;
}

function History({ plan, list, media }: { plan: Plan; list: SharedListDetail; media: Map<number, MediaLite> }) {
  const past = plan.sessions.filter(s => s.status === "done" || s.status === "cancelled").reverse();
  return <section className="space-y-3 border-t border-gray-700 pt-6">
    <h3 className="text-lg font-semibold">История сеансов</h3>
    {past.length ? <ul className="grid gap-3 md:grid-cols-2">{past.map(s => {
      const m = media.get(s.anilistId); const when = formatAiring(s.startsAt);
      return <li key={s.id} className="flex gap-4 rounded-xl bg-gray-800/40 p-4">
        <Cover m={m} className="h-24 w-16" />
        <div className="min-w-0 space-y-2"><p className="text-xs text-gray-400">{when.date} · {when.time} {when.tz}</p>
          <Link className="block font-medium hover:text-accent-300" href={`/anime/${s.anilistId}`}>{m ? displayTitle(m.title) : `Тайтл #${s.anilistId}`}</Link>
          <div className="space-y-1 text-sm text-gray-400">{(s.plan?.blocks ?? legacyBlocks(s)).map(b => <p key={b.anilistId}>{media.get(b.anilistId) ? displayTitle(media.get(b.anilistId)!.title) : `#${b.anilistId}`} · серии {episodeLabel(b.episodes)}</p>)}<p>{s.status === "cancelled" ? "Отменён" : "Завершён"}</p></div>
          <AvatarStack members={list.members.filter(u => s.rsvp.some(r => r.userId === u.id && r.answer === "yes"))} label="Подтвердили участие (RSVP)" />
        </div>
      </li>;
    })}</ul> : <p className="text-sm text-gray-400">Здесь появятся прошедшие сеансы комнаты.</p>}
  </section>;
}
