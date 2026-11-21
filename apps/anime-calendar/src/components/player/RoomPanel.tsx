"use client";
import { UserGroupIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { netTone, type RoomAction, type RoomMember, type RoomState, type RoomView } from "@/lib/room";
import { Avatar } from "../Avatar";
import { Badge, Button, cx, Spinner } from "../ui";
import { clock } from "./Player";
import type { RoomHandle } from "./useRoom";

// «Смотрим вместе» под «Озвучкой / Субтитрами»: комнаты нет — создать и позвать друзей; позвали — войти; в комнате —
// участники (кто смотрит, кто на паузе, кто грузится и отстаёт, связь), кто что нажал, приглашения и права.

type Friend = { id: number; name: string };
/** Группа, где есть этот тайтл: позвать всех её участников с её пресетом и пультом. */
type Group = { id: number; name: string; members: Friend[] };

const ACTION_TEXT: Record<RoomAction["kind"], string> = {
  play: "смотреть", pause: "пауза", seek: "перемотка", ep: "серия", join: "в комнате", leave: "вне комнаты",
  hold: "грузится, ждём", resume: "загрузилось", skip: "смотрим без ожидания",
};

export function actionText(a: RoomAction, name: string) {
  const at = a.kind === "ep" ? ` ${a.ep}` : a.pos !== null && ["play", "pause", "seek"].includes(a.kind) ? ` · ${clock(a.pos)}` : "";
  return `${name}: ${ACTION_TEXT[a.kind]}${at}`;
}

function memberLine(m: RoomMember, s: RoomState): { text: string; tone: string; busy?: boolean } {
  if (m.status === "invited") return { text: "позвали", tone: "text-gray-500" };
  if (m.status === "left") return { text: "вне комнаты", tone: "text-gray-500" };
  const p = m.presence;
  if (!p?.online) return { text: "не в сети", tone: "text-gray-500" };
  if (p.playbackError) return { text: "Нет видеосоединения", tone: "text-negative-300" };
  if (p.buffering) return { text: "грузится", tone: "text-warning-300", busy: true };
  if (p.drift !== null && Math.abs(p.drift) > 1.5) return { text: `${p.drift < 0 ? "отстаёт" : "спешит"} на ${Math.round(Math.abs(p.drift))} с`, tone: "text-warning-300" };
  return s.playing ? { text: "смотрит", tone: "text-positive-300" } : { text: "на паузе", tone: "text-gray-400" };
}

const NET_DOT = { positive: "bg-positive-400", warning: "bg-warning-400", negative: "bg-negative-400", neutral: "bg-gray-500" } as const;

export function RoomPanel({ handle, invited, friends, groups, onCreate, onJoin, onLeave }: {
  handle: RoomHandle;
  /** Позвали в комнату тайтла (ещё не вошли) */
  invited: RoomView | null;
  friends: Friend[];
  groups: Group[];
  onCreate: (ids: number[], group?: number) => Promise<void>;
  onJoin: (id: string) => void;
  onLeave: () => void;
}) {
  const room = handle.room;
  const me = room?.members.find((m) => m.id === room.me);
  const inRoom = room && !handle.ended && me?.status === "joined";
  return (
    <section className="space-y-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <UserGroupIcon className="h-4 w-4 text-gray-400" /> Смотрим вместе
        {inRoom && <span className="ml-auto text-xs font-normal text-gray-500">{room.state.ep} серия</span>}
      </h2>
      {inRoom ? <InRoom room={room} handle={handle} friends={friends} onLeave={onLeave} />
        : invited ? <Invite room={invited} onJoin={onJoin} />
        : <Create friends={friends} groups={groups} ended={handle.ended} onCreate={onCreate} />}
    </section>
  );
}

function Invite({ room, onJoin }: { room: RoomView; onJoin: (id: string) => void }) {
  const owner = room.members.find((m) => m.id === room.ownerId);
  const joined = room.members.filter((m) => m.status === "joined");
  return (
    <div className="space-y-2 text-sm">
      <p className="text-gray-300"><b>{owner?.name}</b> зовёт смотреть {room.state.ep} серию{joined.length > 1 ? ` (в комнате ${joined.length})` : ""}.</p>
      <Button size="sm" variant="primary" onClick={() => onJoin(room.id)}>Присоединиться</Button>
    </div>
  );
}

function Create({ friends, groups, ended, onCreate }: { friends: Friend[]; groups: Group[]; ended: boolean; onCreate: (ids: number[], group?: number) => Promise<void> }) {
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } finally { setBusy(false); } };
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-gray-400">
        {ended ? "Комната закончилась. " : ""}Комната — на один сеанс: пауза, перемотка и смена серии у всех сразу, поток у каждого свой.
      </p>
      {groups.length > 0 && (
        <div className="space-y-1">
          {groups.map((g) => (
            <button key={g.id} disabled={busy} onClick={() => void run(() => onCreate([], g.id))}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left ring-1 ring-gray-700 hover:bg-gray-700/50">
              <span className="flex -space-x-1.5">{g.members.slice(0, 4).map((m) => <Avatar key={m.id} user={m} className="h-5 w-5 text-[10px] ring-1 ring-gray-900" />)}</span>
              <span className="min-w-0 flex-1 truncate">Позвать группу «{g.name}»</span>
              <span className="text-xs text-gray-500">{g.members.length}</span>
            </button>
          ))}
        </div>
      )}
      {friends.length ? (
        <div className="max-h-40 space-y-0.5 overflow-y-auto">
          {friends.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-gray-700/50">
              <input type="checkbox" checked={pick.has(f.id)} className="accent-accent-500"
                onChange={() => setPick((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
              <Avatar user={f} className="h-6 w-6 text-xs" />
              <span className="truncate">{f.name}</span>
            </label>
          ))}
        </div>
      ) : <p className="text-xs text-gray-500">Друзей пока нет — комнату можно создать и позвать позже.</p>}
      <Button size="sm" variant="primary" disabled={busy}
        onClick={() => void run(() => onCreate([...pick]))}>
        {busy && <Spinner className="h-3.5 w-3.5" />} Создать комнату{pick.size ? ` и позвать (${pick.size})` : ""}
      </Button>
    </div>
  );
}

function InRoom({ room, handle, friends, onLeave }: { room: RoomView; handle: RoomHandle; friends: Friend[]; onLeave: () => void }) {
  const isOwner = room.me === room.ownerId;
  const [inviting, setInviting] = useState(false);
  const names = new Map(room.members.map((m) => [m.id, m.name]));
  const outside = friends.filter((f) => (!room.groupId || room.members.some(m => m.id === f.id)) && !room.members.some((m) => m.id === f.id && m.status !== "left"));
  const shown = room.members.filter((m) => m.status !== "left" || m.presence?.online);
  const waiting = room.state.hold.map((u) => names.get(u)).filter(Boolean);
  return (
    <div className="space-y-3 text-sm">
      {waiting.length > 0 && <p className="tone-warning soft rounded-md px-2 py-1 text-xs ring-1 ring-inset">Ждём: {waiting.join(", ")}</p>}
      <ul className="space-y-1">
        {shown.map((m) => {
          const line = memberLine(m, room.state);
          const tone = netTone(m.presence);
          const p = m.presence;
          return (
            <li key={m.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <Avatar user={m} className={cx("h-7 w-7 text-xs", !p?.online && "opacity-50")} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate">
                  <span className="truncate">{m.name}</span>
                  {m.host && <Badge tone="special">организатор</Badge>}
                  {room.preset === "host" && !m.host && m.control && <Badge tone="info">управляет</Badge>}
                </p>
                <p className={cx("flex items-center gap-1 text-xs", line.tone)}>
                  {line.busy && <Spinner className="h-3 w-3" />}{line.text}
                  {p?.online && (p.bw !== null || p.rtt !== null) && (
                    <span className="ml-auto flex items-center gap-1 text-gray-400" title="Скорость потока и задержка до сервера">
                      <span className={cx("h-1.5 w-1.5 rounded-full", NET_DOT[tone])} />
                      {p.bw !== null && `${(p.bw / 1e6).toFixed(1)} Мбит/с`}{p.bw !== null && p.rtt !== null && " · "}{p.rtt !== null && `${p.rtt} мс`}
                    </span>
                  )}
                </p>
              </div>
              {isOwner && !room.groupId && room.preset === "host" && !m.host && m.status === "joined" && (
                <button onClick={() => void handle.act({ action: "grant", user: m.id, control: !m.control })}
                  className="rounded px-1.5 py-0.5 text-xs text-gray-400 ring-1 ring-gray-600 hover:text-white" title="Право ставить паузу, перематывать и менять серию">
                  {m.control ? "забрать" : "дать пульт"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {isOwner && !room.groupId && (
        <div className="flex rounded-md bg-gray-900/60 p-0.5 text-xs ring-1 ring-gray-700">
          {([["equal", "Все управляют"], ["host", "Организатор"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => void handle.act({ action: "preset", preset: k })}
              className={cx("flex-1 rounded px-2 py-1", room.preset === k ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200")}>{l}</button>
          ))}
        </div>
      )}
      {!isOwner && room.preset === "host" && !handle.canControl && <p className="text-xs text-gray-500">Пауза и перемотка — у организатора.</p>}

      {room.actions.length > 0 && (
        <div className="space-y-0.5 border-t border-gray-700 pt-2">
          {room.actions.slice(-5).reverse().map((a, i) => (
            <p key={`${a.at}:${i}`} className="flex gap-2 text-xs text-gray-400">
              <span className="min-w-0 flex-1 truncate">{actionText(a, names.get(a.userId) ?? "?")}</span>
              <span className="tabular-nums text-gray-600">{new Date(a.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
            </p>
          ))}
        </div>
      )}

      {inviting && room.canInvite !== false ? (
        <div className="space-y-1 border-t border-gray-700 pt-2">
          {outside.length ? outside.map((f) => (
            <button key={f.id} onClick={() => void handle.act({ action: "invite", users: [f.id] })}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-gray-700/50">
              <Avatar user={f} className="h-6 w-6 text-xs" /><span className="flex-1 truncate">{f.name}</span><span className="text-xs text-accent-300">позвать</span>
            </button>
          )) : <p className="text-xs text-gray-500">Все друзья уже в комнате.</p>}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={room.canInvite === false} onClick={() => setInviting((x) => !x)}>{inviting ? "Готово" : "Позвать"}</Button>
        <Button size="sm" variant="ghost" onClick={async () => { await handle.act({ action: isOwner ? "end" : "leave" }); onLeave(); }}>
          {isOwner ? "Закончить" : "Выйти"}
        </Button>
      </div>
    </div>
  );
}
