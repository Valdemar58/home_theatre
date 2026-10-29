"use client";
import { AdjustmentsHorizontalIcon, ArrowDownIcon, ArrowUpIcon, CalendarDaysIcon, CheckIcon, ChartBarIcon, QueueListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, useMe } from "@/lib/client";
import { sessionEps, SESSION_MAX_EPS, type GroupPlan as Plan, type GroupSession, type Rsvp } from "@/lib/groups";
import { displayTitle } from "@/lib/schedule";
import { formatAiring, relative } from "@/lib/time";
import type { MediaLite, SharedListDetail } from "@/lib/types";
import { Avatar } from "./Avatar";
import { useConfirm } from "./Dialogs";
import { Img } from "./Img";
import { Badge, Button, cx, ErrorBox } from "./ui";

// Группа просмотра (TASKS 9.4в) на странице общего списка: сеансы по расписанию («приду / не приду»), очередь с
// прогрессом и озвучкой группы, голосование, что смотреть, и кто управляет комнатой (пресет и пульт).

const RSVP: [Rsvp, string][] = [["yes", "Приду"], ["maybe", "Может быть"], ["no", "Не приду"]];
const field = "h-9 rounded-lg border border-gray-600 bg-gray-900 px-2 text-sm focus:border-accent-500 focus:outline-none";

/** По умолчанию — сегодня в 21:00 (уже прошло — завтра), в поясе устройства, для <input type="datetime-local">. */
function defaultStart() {
  const d = new Date();
  d.setHours(21, 0, 0, 0);
  if (d.getTime() < Date.now() + 30 * 60_000) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function GroupPlan({ list }: { list: SharedListDetail }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const key = ["group", list.id];
  const { data: plan, error } = useQuery({ queryKey: key, queryFn: () => api<Plan>(`/api/shared-lists/${list.id}/group`), refetchInterval: 30_000 });
  const [err, setErr] = useState<unknown>(null);
  const act = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      qc.setQueryData(key, await api<Plan>(`/api/shared-lists/${list.id}/group`, { method: "POST", json: body }));
    } catch (e) {
      setErr(e);
    }
  };
  if (error) return <ErrorBox error={error} />;
  if (!plan || !me) return null;
  const media = new Map(list.items.map((i) => [i.media.id, i.media]));
  const name = (id: number) => (id === me.id ? "Вы" : list.members.find((m) => m.id === id)?.name ?? "?");
  return (
    <div className="space-y-3">
      {Boolean(err) && <ErrorBox error={err} />}
      <div className="grid gap-4 xl:grid-cols-2">
        <Sessions plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
        <Queue plan={plan} list={list} media={media} act={act} />
        <Poll plan={plan} list={list} media={media} me={me.id} name={name} act={act} />
        <Control plan={plan} list={list} me={me.id} act={act} />
      </div>
    </div>
  );
}

type Act = (body: Record<string, unknown>) => Promise<void>;

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
  const [form, setForm] = useState(false);
  const upcoming = plan.sessions.filter((s) => s.status === "planned" || s.status === "live");
  const past = plan.sessions.filter((s) => s.status === "done" || s.status === "cancelled").slice(-3).reverse();
  return (
    <Card icon={<CalendarDaysIcon className="h-4 w-4 text-gray-400" />} title="Сеансы"
      aside={plan.canPlan && !form && <button onClick={() => setForm(true)} className="text-accent-300 hover:text-accent-200">Назначить</button>}>
      {form && <SessionForm plan={plan} list={list} onDone={() => setForm(false)} act={act} />}
      {upcoming.length ? (
        <ul className="space-y-2">
          {upcoming.map((s) => (
            <SessionRow key={s.id} s={s} m={media.get(s.anilistId)} me={me} name={name} members={list.members.filter((x) => x.status === "member").map((x) => x.id)}
              canCancel={s.status === "planned" && (s.createdBy === me || list.ownerId === me)}
              onRsvp={(answer) => act({ action: "rsvp", sessionId: s.id, answer })}
              onCancel={async () => { if (await confirm({ title: "Отменить сеанс?", text: "Участники получат уведомление.", confirm: "Отменить сеанс", danger: true })) void act({ action: "session-cancel", sessionId: s.id }); }} />
          ))}
        </ul>
      ) : !form && <p className="text-sm text-gray-500">Сеансов не назначено. В назначенное время комната откроется сама, за час до начала серии начнут готовиться.</p>}
      {past.length > 0 && (
        <div className="space-y-0.5 border-t border-gray-700 pt-2 text-xs text-gray-500">
          {past.map((s) => (
            <p key={s.id}>{s.status === "cancelled" ? "отменён" : "прошёл"} · {media.get(s.anilistId) ? displayTitle(media.get(s.anilistId)!.title) : "?"}, {sessionEps(s)} · {formatAiring(s.startsAt).date}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

function SessionRow({ s, m, me, name, members, canCancel, onRsvp, onCancel }: {
  s: GroupSession; m: MediaLite | undefined; me: number; name: (id: number) => string; members: number[];
  canCancel: boolean; onRsvp: (a: Rsvp) => void; onCancel: () => void;
}) {
  const when = formatAiring(s.startsAt);
  const mine = s.rsvp.find((r) => r.userId === me)?.answer;
  const silent = members.filter((u) => !s.rsvp.some((r) => r.userId === u));
  return (
    <li className="flex gap-3 rounded-lg bg-gray-900/40 p-2.5">
      <Cover m={m} className="h-16 w-11" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{m ? displayTitle(m.title) : "?"} · {sessionEps(s)}</p>
            <p className="text-xs text-gray-400">{when.weekday}, {when.date}, {when.time} {when.tz} · {relative(s.startsAt)}</p>
          </div>
          {s.status === "live" && s.roomId
            ? <Link href={`/anime/${s.anilistId}/watch/${s.ep}?room=${s.roomId}`}><Badge tone="positive">идёт · войти</Badge></Link>
            : canCancel && <button onClick={onCancel} title="Отменить сеанс" className="rounded p-0.5 text-gray-500 hover:bg-gray-700 hover:text-white"><XMarkIcon className="h-4 w-4" /></button>}
        </div>
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
            {silent.length > 0 && <span className="text-xs text-gray-500">не ответили: {silent.map(name).join(", ")}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function SessionForm({ plan, list, onDone, act }: { plan: Plan; list: SharedListDetail; onDone: () => void; act: Act }) {
  // Тайтлы: сначала очередь, потом остальные недосмотренные
  const queued = plan.queue.map((q) => q.anilistId);
  const options = [...queued, ...list.items.filter((i) => i.state !== "done" && !queued.includes(i.media.id)).map((i) => i.media.id)];
  const title = (id: number) => { const m = list.items.find((i) => i.media.id === id)?.media; return m ? displayTitle(m.title) : "?"; };
  const nextEp = (id: number) => (plan.queue.find((q) => q.anilistId === id)?.progress ?? 0) + 1;
  const [anilistId, setId] = useState(options[0] ?? 0);
  const [ep, setEp] = useState(nextEp(options[0] ?? 0));
  const [count, setCount] = useState(2);
  const [at, setAt] = useState(defaultStart);
  if (!options.length) return <p className="text-sm text-gray-500">Добавьте в группу тайтл — тогда можно назначить сеанс.</p>;
  return (
    <form className="space-y-2 rounded-lg bg-gray-900/40 p-3" onSubmit={async (e) => {
      e.preventDefault();
      await act({ action: "session-create", anilistId, ep, count, startsAt: Math.floor(new Date(at).getTime() / 1000) });
      onDone();
    }}>
      <select value={anilistId} onChange={(e) => { const id = Number(e.target.value); setId(id); setEp(nextEp(id)); }} className={cx(field, "w-full")}>
        {options.map((id) => <option key={id} value={id}>{queued.includes(id) ? "⏵ " : ""}{title(id)}</option>)}
      </select>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5">с серии <input type="number" min={1} value={ep} onChange={(e) => setEp(Number(e.target.value))} className={cx(field, "w-16")} /></label>
        <label className="flex items-center gap-1.5">серий <input type="number" min={1} max={SESSION_MAX_EPS} value={count} onChange={(e) => setCount(Number(e.target.value))} className={cx(field, "w-16")} /></label>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={field} required />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit">Назначить</Button>
        <Button size="sm" variant="ghost" type="button" onClick={onDone}>Отмена</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- очередь

function Queue({ plan, list, media, act }: { plan: Plan; list: SharedListDetail; media: Map<number, MediaLite>; act: Act }) {
  const rest = list.items.filter((i) => i.state !== "done" && !plan.queue.some((q) => q.anilistId === i.media.id));
  return (
    <Card icon={<QueueListIcon className="h-4 w-4 text-gray-400" />} title="Очередь" aside="первый — смотрим сейчас">
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
                    <span>{q.progress ? `группа на ${q.progress}${total ? `/${total}` : ""}` : "группа ещё не начала"}</span>
                    <VoiceField value={q.voice} onSave={(voice) => act({ action: "voice", anilistId: q.anilistId, voice })} />
                  </p>
                </div>
                <span className="flex shrink-0">
                  <IconBtn label="Выше" disabled={k === 0} onClick={() => act({ action: "queue-move", anilistId: q.anilistId, dir: -1 })}><ArrowUpIcon className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn label="Ниже" disabled={k === plan.queue.length - 1} onClick={() => act({ action: "queue-move", anilistId: q.anilistId, dir: 1 })}><ArrowDownIcon className="h-3.5 w-3.5" /></IconBtn>
                  <IconBtn label="Убрать из очереди" onClick={() => act({ action: "queue-remove", anilistId: q.anilistId })}><XMarkIcon className="h-3.5 w-3.5" /></IconBtn>
                </span>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-sm text-gray-500">Очередь пуста: добавьте тайтл или запустите голосование.</p>}
      {rest.length > 0 && (
        <select value="" onChange={(e) => e.target.value && void act({ action: "queue-add", anilistId: Number(e.target.value) })} className={cx(field, "w-full text-gray-400")}>
          <option value="">+ В очередь…</option>
          {rest.map((i) => <option key={i.media.id} value={i.media.id}>{displayTitle(i.media.title)}</option>)}
        </select>
      )}
    </Card>
  );
}

/** Озвучка группы для тайтла: студия (её звук готовится к сеансу); пусто — у каждого своя. */
function VoiceField({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if ((v.trim() || null) !== value) onSave(v.trim() || null); }}
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
  const candidates = list.items.filter((i) => i.state === "planned");
  const [pick, setPick] = useState<Set<number>>(() => new Set(candidates.map((i) => i.media.id)));
  const [hours, setHours] = useState(24);
  const max = p ? Math.max(1, ...p.options.map((o) => o.votes.length)) : 1;
  return (
    <Card icon={<ChartBarIcon className="h-4 w-4 text-gray-400" />} title="Что смотрим дальше"
      aside={open ? `ещё ${relative(p.closesAt).replace(/^через /, "")}` : plan.canPlan && !creating && <button onClick={() => setCreating(true)} className="text-accent-300 hover:text-accent-200">Голосование</button>}>
      {p && (
        <ul className="space-y-1.5">
          {p.options.map((o) => {
            const m = media.get(o.anilistId);
            const mine = o.votes.includes(me);
            const won = p.winner === o.anilistId;
            return (
              <li key={o.anilistId}>
                <button disabled={!open} onClick={() => act({ action: "vote", pollId: p.id, anilistId: o.anilistId })}
                  className={cx("relative flex w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-sm ring-1",
                    won ? "tone-positive soft" : mine ? "ring-accent-500/60" : "ring-gray-700", open && "hover:bg-gray-700/40")}>
                  <span className="absolute inset-y-0 left-0 bg-accent-500/15" style={{ width: `${(o.votes.length / max) * 100}%` }} />
                  <span className={cx("relative grid h-4 w-4 shrink-0 place-items-center rounded ring-1", mine ? "bg-accent-500 ring-accent-500" : "ring-gray-500")}>
                    {mine && <CheckIcon className="h-3 w-3 text-white" />}
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{m ? displayTitle(m.title) : "?"}</span>
                  <span className="relative text-xs text-gray-400" title={o.votes.map(name).join(", ") || undefined}>{o.votes.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {p && !open && <p className="text-xs text-gray-500">{p.winner ? "Победитель — в очереди." : "Никто не проголосовал."}</p>}
      {open && (p.createdBy === me || list.ownerId === me) && (
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
            <Button size="sm" variant="primary" disabled={pick.size < 2} onClick={async () => { await act({ action: "poll-create", options: [...pick], hours }); setCreating(false); }}>Запустить</Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Отмена</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- управление

function Control({ plan, list, me, act }: { plan: Plan; list: SharedListDetail; me: number; act: Act }) {
  const owner = list.ownerId === me;
  return (
    <Card icon={<AdjustmentsHorizontalIcon className="h-4 w-4 text-gray-400" />} title="Кто управляет просмотром">
      <div className="flex rounded-md bg-gray-900/60 p-0.5 text-xs ring-1 ring-gray-700">
        {([["equal", "Все управляют"], ["host", "Организатор"]] as const).map(([k, l]) => (
          <button key={k} disabled={!owner} onClick={() => act({ action: "preset", preset: k })}
            className={cx("flex-1 rounded px-2 py-1", plan.preset === k ? "bg-gray-700 text-white" : "text-gray-400", owner && plan.preset !== k && "hover:text-gray-200")}>{l}</button>
        ))}
      </div>
      <p className="text-xs text-gray-500">
        {plan.preset === "equal"
          ? "В комнатах группы паузу, перемотку и серию меняет любой; сеансы и голосования назначает любой участник."
          : "Пульт — у организатора и тех, кому он его дал: они управляют комнатой, назначают сеансы и голосования."}
      </p>
      {plan.preset === "host" && (
        <ul className="space-y-1">
          {list.members.filter((m) => m.status === "member").map((m) => {
            const isOwner = m.id === list.ownerId;
            const has = isOwner || plan.control.includes(m.id);
            return (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <Avatar user={m} className="h-6 w-6 text-xs" />
                <span className="flex-1 truncate">{m.id === me ? "Вы" : m.name}</span>
                {isOwner ? <Badge tone="special">организатор</Badge>
                  : owner ? (
                    <button onClick={() => act({ action: "grant", userId: m.id, control: !has })}
                      className="rounded px-1.5 py-0.5 text-xs text-gray-400 ring-1 ring-gray-600 hover:text-white">{has ? "забрать пульт" : "дать пульт"}</button>
                  ) : has && <Badge tone="info">пульт</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
