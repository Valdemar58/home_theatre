"use client";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { episodesRange, togetherChange } from "@/lib/together-rules";
import type { CoWatcher, MediaLite, TogetherState } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Button, Modal, cx } from "./ui";

// «Посмотрели вместе»: одна общая отметка «до серии N» + галочки участников.
// Кто ушёл раньше — клик по его числу даёт ему свой номер серии. Прогресс только растёт.

function Stepper({ value, onChange, min, max, small }: { value: number; onChange: (n: number) => void; min: number; max: number | null; small?: boolean }) {
  const clamp = (n: number) => Math.max(min, max ? Math.min(max, n) : n);
  return (
    <span className={cx("inline-flex items-center rounded-lg bg-gray-900/60 ring-1 ring-gray-600", small ? "h-7" : "h-9")}>
      <button type="button" onClick={() => onChange(clamp(value - 1))} className="px-1.5 text-gray-400 hover:text-white" aria-label="Меньше"><ChevronLeftIcon className="h-4 w-4" /></button>
      <input value={value} inputMode="numeric" onChange={(e) => onChange(clamp(Number(e.target.value.replace(/\D/g, "")) || min))}
        className={cx("bg-transparent text-center font-semibold tabular-nums focus:outline-none", small ? "w-8 text-sm" : "w-10")} />
      <button type="button" onClick={() => onChange(clamp(value + 1))} className="px-1.5 text-gray-400 hover:text-white" aria-label="Больше"><ChevronRightIcon className="h-4 w-4" /></button>
    </span>
  );
}

export function WatchTogetherDialog({ media, state, open, onClose, initialUpTo }: {
  media: MediaLite; state: TogetherState; open: boolean; onClose: () => void; initialUpTo?: number;
}) {
  const qc = useQueryClient();
  const total = media.episodes;
  const [upTo, setUpTo] = useState(initialUpTo ?? state.upTo);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [own, setOwn] = useState<Map<number, number>>(new Map());
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Открыли окно — состояние по умолчанию (участники общих списков и я отмечены)
  useEffect(() => {
    if (!open) return;
    setUpTo(initialUpTo ?? state.upTo);
    setChecked(new Set(state.people.filter((p) => p.me || p.inSharedList).map((p) => p.id)));
    setOwn(new Map());
    setDone(null);
    setMoreOpen(false);
  }, [open, initialUpTo, state]);

  const target = (p: CoWatcher) => own.get(p.id) ?? upTo;
  const change = (p: CoWatcher) => togetherChange({ userId: p.id, status: p.status, episodes: p.episodes }, target(p), total);
  const main = state.people.filter((p) => p.me || p.inSharedList);
  const more = state.people.filter((p) => !p.me && !p.inSharedList);
  const marks = state.people.filter((p) => checked.has(p.id) && change(p)).map((p) => ({ userId: p.id, upTo: target(p) }));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ changes: { name: string; from: number; to: number }[] }>(`/api/anime/${media.id}/together`, { method: "POST", json: { marks } });
      setDone(r.changes.map((c) => `${c.name}: ${episodesRange(c.from, c.to)}`).join(" · ") || "Ничего не изменилось");
      void qc.invalidateQueries({ queryKey: ["list"] });
      void qc.invalidateQueries({ queryKey: ["together", media.id] });
      void qc.invalidateQueries({ queryKey: ["shared-list"] });
      void qc.invalidateQueries({ queryKey: ["opinions", media.id] });
    } finally {
      setBusy(false);
    }
  };

  const row = (p: CoWatcher) => {
    const ch = change(p);
    const on = checked.has(p.id);
    const toggle = () => setChecked((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
    return (
      <li key={p.id} className={cx("flex items-center gap-3 rounded-lg px-2 py-1.5", on ? "bg-gray-700/40" : "opacity-70")}>
        <input type="checkbox" checked={on} onChange={toggle} className="h-4 w-4 accent-indigo-500" aria-label={p.name} />
        <Avatar user={p} />
        <span className="min-w-0 flex-1 truncate text-sm">{p.me ? "Вы" : p.name}</span>
        <span className="flex items-center gap-1.5 text-sm tabular-nums text-gray-400">
          {p.status === "completed" ? <span className="text-xs">{LIST_LABELS.completed.toLowerCase()}</span> : (
            <>
              {p.episodes}
              <span className="text-gray-600">→</span>
              {own.has(p.id) ? (
                <Stepper small value={own.get(p.id)!} min={0} max={total} onChange={(n) => setOwn((m) => new Map(m).set(p.id, n))} />
              ) : (
                <button type="button" title="Этот участник посмотрел меньше — указать его серию" disabled={!on}
                  onClick={() => setOwn((m) => new Map(m).set(p.id, Math.max(p.episodes, upTo - 1)))}
                  className={cx("rounded px-1 font-semibold underline decoration-dotted underline-offset-4", ch ? "text-gray-100 hover:bg-gray-600" : "text-gray-500")}>
                  {ch ? ch.to : p.episodes}
                </button>
              )}
            </>
          )}
        </span>
      </li>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Посмотрели вместе">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-300">до серии</span>
          <Stepper value={upTo} min={1} max={total} onChange={(n) => { setUpTo(n); setOwn(new Map()); }} />
          {total && <span className="text-sm text-gray-500">из {total}</span>}
          {total && upTo !== total && <Button size="sm" variant="ghost" onClick={() => { setUpTo(total); setOwn(new Map()); }}>все</Button>}
        </div>

        <ul className="space-y-1">{main.map(row)}</ul>
        {more.length > 0 && (
          <div>
            <button type="button" onClick={() => setMoreOpen(!moreOpen)} className="text-xs text-indigo-300 hover:text-indigo-200">
              {moreOpen ? "Скрыть остальных друзей" : `Ещё друзья (${more.length})`}
            </button>
            {moreOpen && <ul className="mt-1 space-y-1">{more.map(row)}</ul>}
          </div>
        )}
        <p className="text-xs text-gray-500">
          Нажмите на число справа, если кто-то посмотрел меньше. Прогресс только растёт; досмотревшим ничего не меняется.
          Друзьям придёт уведомление, где отметку можно отменить.
        </p>

        {done ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-200 ring-1 ring-green-500/30">
            <span>Отмечено — {done}</span>
            <Button size="sm" onClick={onClose}>Готово</Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy || !marks.length} onClick={submit}>
              {marks.length ? `Отметить (${marks.length})` : "Нечего отмечать"}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
