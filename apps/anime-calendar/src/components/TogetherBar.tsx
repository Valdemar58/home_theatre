"use client";
import { CheckIcon, PlayIcon, PlusIcon, QueueListIcon, UsersIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, useTogether } from "@/lib/client";
import { episodesRange } from "@/lib/together-rules";
import type { MediaLite, TogetherEvent } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Button, Modal, cx } from "./ui";
import { WatchTogetherDialog } from "./WatchTogetherDialog";

// Совместный просмотр на странице тайтла: «Посмотрели вместе», «Смотрим вместе с…», «В общий список»,
// плашки идущего совместного просмотра и «Петя отметил вам серии — Отменить».

export function TogetherBar({ media, together, undo }: { media: MediaLite; together?: number; undo?: number }) {
  const { data: state } = useTogether(media.id);
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(false);
  const [session, setSession] = useState(false);
  const [menu, setMenu] = useState(false);
  const opened = useRef(false);

  // Пришли из подсказки «отметить и для …?» — сразу открыть окно
  useEffect(() => {
    if (together && state && !opened.current) { opened.current = true; setDialog(true); }
  }, [together, state]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["together", media.id] });
    void qc.invalidateQueries({ queryKey: ["list"] });
  };
  if (!state) return null;
  const friends = state.people.filter((p) => !p.me);
  if (!friends.length && !state.lists.length) return undo ? <UndoBanner id={undo} onDone={refresh} /> : null;
  const s = state.session;

  const toggleList = async (listId: number, has: boolean) => {
    if (has) await api(`/api/shared-lists/${listId}/items?anilistId=${media.id}`, { method: "DELETE" });
    else await api(`/api/shared-lists/${listId}/items`, { method: "POST", json: { anilistId: media.id } });
    void qc.invalidateQueries({ queryKey: ["together", media.id] });
    void qc.invalidateQueries({ queryKey: ["shared-lists"] });
  };
  const endSession = async () => { await api(`/api/anime/${media.id}/session`, { method: "DELETE" }); refresh(); };

  return (
    <div className="space-y-2">
      {undo && <UndoBanner id={undo} onDone={refresh} />}
      {s && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 ring-1 ring-emerald-500/30">
          <PlayIcon className="h-4 w-4 shrink-0" />
          {s.mine ? (
            <span>Смотрите вместе с <b>{s.members.map((m) => m.name).join(", ")}</b> — отмеченные вами серии засчитываются и им</span>
          ) : (
            <span><b>{s.owner.name}</b> смотрит вместе с вами — его серии засчитываются и вам</span>
          )}
          <span className="ml-auto flex gap-1.5">
            {s.mine && <Button size="sm" variant="ghost" onClick={() => setSession(true)}>Кто смотрит</Button>}
            <Button size="sm" onClick={endSession}>{s.mine ? "Закончить" : "Выйти"}</Button>
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {friends.length > 0 && (
          <>
            <Button size="sm" onClick={() => setDialog(true)} title="Отметить серии себе и тем, кто смотрел с вами">
              <UsersIcon className="h-4 w-4" />Посмотрели вместе
            </Button>
            {!s && (
              <Button size="sm" onClick={() => setSession(true)} title="Пока включено, серии, отмеченные вам (и из Jellyfin), отмечаются и друзьям">
                <PlayIcon className="h-4 w-4" />Смотрим вместе…
              </Button>
            )}
          </>
        )}
        <div className="relative">
          <Button size="sm" onClick={() => setMenu(!menu)}><QueueListIcon className="h-4 w-4" />В общий список</Button>
          {menu && (
            <div className="mobile-popover absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg bg-gray-800 py-1 shadow-2xl ring-1 ring-gray-600" onMouseLeave={() => setMenu(false)}>
              {state.lists.map((l) => (
                <button key={l.id} onClick={() => toggleList(l.id, l.has)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-700">
                  <CheckIcon className={cx("h-4 w-4", l.has ? "text-green-400" : "invisible")} />
                  <span className="truncate">{l.name}</span>
                </button>
              ))}
              <Link href={`/groups?create=${media.id}`} className="flex items-center gap-2 border-t border-gray-700 px-3 py-2 text-sm text-indigo-300 hover:bg-gray-700">
                <PlusIcon className="h-4 w-4" />Новый общий список…
              </Link>
            </div>
          )}
        </div>
      </div>

      <WatchTogetherDialog media={media} state={state} open={dialog} onClose={() => setDialog(false)} initialUpTo={together} />
      <SessionModal media={media} open={session} onClose={() => setSession(false)}
        friends={friends} current={s?.mine ? s.members.map((m) => m.id) : null} onDone={refresh} />
    </div>
  );
}

function SessionModal({ media, open, onClose, friends, current, onDone }: {
  media: MediaLite; open: boolean; onClose: () => void; friends: { id: number; name: string; inSharedList: boolean }[];
  current: number[] | null; onDone: () => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (open) setPicked(new Set(current ?? friends.filter((f) => f.inSharedList).map((f) => f.id)));
  }, [open, current, friends]);
  const save = async () => {
    await api(`/api/anime/${media.id}/session`, { method: current ? "PATCH" : "POST", json: { members: [...picked] } });
    onDone();
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={current ? "Кто смотрит с вами" : "Смотрим вместе"}>
      <div className="space-y-4">
        <p className="text-sm text-gray-400">
          Пока режим включён, каждая серия, отмеченная вам — вручную или после просмотра в Jellyfin на вашем аккаунте, — засчитывается и выбранным друзьям.
          Ушёл кто-то раньше — снимите галочку. Режим выключится сам через 6 часов без просмотра.
        </p>
        <ul className="space-y-1">
          {friends.map((f) => (
            <li key={f.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-gray-700/40">
                <input type="checkbox" checked={picked.has(f.id)} className="h-4 w-4 accent-indigo-500"
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />
                <Avatar user={f} />
                <span className="text-sm">{f.name}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          {current && <Button variant="ghost" onClick={async () => { await api(`/api/anime/${media.id}/session`, { method: "DELETE" }); onDone(); onClose(); }}>Закончить</Button>}
          <Button variant="primary" disabled={!picked.size} onClick={save}>{current ? "Сохранить" : "Начать"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function UndoBanner({ id, onDone }: { id: number; onDone: () => void }) {
  const { data: ev, refetch } = useQuery({ queryKey: ["together-event", id], queryFn: () => api<TogetherEvent>(`/api/together/${id}`), retry: false });
  const [result, setResult] = useState<string | null>(null);
  if (!ev) return null;
  const undo = async () => {
    const r = await api<{ undone: number; skipped: number }>(`/api/together/${id}`, { method: "POST" });
    setResult(r.undone ? "Отменено" : "Не отменено: запись с тех пор менялась — поправьте вручную");
    void refetch();
    onDone();
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100 ring-1 ring-indigo-500/30">
      <span><b>{ev.actor}</b> отметил вам {episodesRange(ev.from, ev.to)} (смотрели вместе)</span>
      <span className="ml-auto">
        {result ?? (ev.undone ? <span className="text-gray-400">отменено</span> : <Button size="sm" onClick={undo}>Отменить</Button>)}
      </span>
    </div>
  );
}
