"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ClockIcon } from "@heroicons/react/24/outline";
type Plan = { id: string; label: string; startsAt: number; endsAt: number };
type Snapshot = { protocol: number; plan: Plan | null; active: boolean; serverNow: number };

export function MaintenanceNotice({ standalone = false }: { standalone?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [clock, setClock] = useState({ now: Date.now(), offset: 0 });
  const [disconnected, setDisconnected] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [fullscreen, setFullscreen] = useState<Element | null>(null);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement instanceof HTMLVideoElement ? null : document.fullscreenElement);
    changed();
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    let disposed = false, busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/maintenance", { cache: "no-store", signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error();
        const value: Snapshot = await response.json();
        if (disposed || value.protocol !== 1) return;
        setSnapshot(previous => { if (previous?.plan && !value.plan && value.serverNow >= previous.plan.startsAt) setCompleted(true); return value; });
        setClock({ now: Date.now(), offset: value.serverNow - Date.now() });
        setDisconnected(false);
      } catch { if (!disposed) setDisconnected(true); }
      finally { busy = false; }
    };
    void refresh();
    const poll = setInterval(() => void refresh(), 3000);
    const tick = setInterval(() => setClock(value => ({ ...value, now: Date.now() })), 1000);
    return () => { disposed = true; clearInterval(poll); clearInterval(tick); };
  }, []);
  const plan = snapshot?.plan;
  const seconds = plan ? Math.max(0, Math.ceil((plan.startsAt - clock.now - clock.offset) / 1000)) : 0;
  const active = !!plan && seconds === 0;
  useEffect(() => {
    if (!active) return;
    const pause = () => document.querySelectorAll("video").forEach(video => video.pause());
    pause();
    window.dispatchEvent(new Event("server-maintenance"));
    document.addEventListener("play", pause, true);
    return () => document.removeEventListener("play", pause, true);
  }, [active]);
  if ((!plan || seconds > 15 * 60) && !completed && !standalone) return null;
  const title = active ? "Обновляем сервер" : plan ? seconds <= 300 ? "Обслуживание скоро начнётся" : "Запланировано обновление сервера" : completed ? "Сервер снова доступен" : "Проверяем доступность сервера";
  const notice = <section aria-label="Обслуживание сервера" className="mb-5 flex min-w-0 flex-wrap items-start gap-3 rounded-xl bg-gray-800 px-4 py-3 text-sm text-gray-100">
    <ClockIcon className="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" aria-hidden="true" />
    <div className="min-w-0 flex-1 basis-56">
      <p className="font-medium" role="status">{title}</p>
      <p className="mt-1 max-w-prose text-gray-300">{active ? "Просмотр приостановлен, позиция сохранена. Дождитесь завершения обновления." : plan ? `Начало в ${new Date(plan.startsAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}. Просмотр будет приостановлен на время обновления.` : completed ? "Обновите страницу, чтобы продолжить с сохранённого места." : "Страница подключится к серверу после обслуживания."}</p>
      {disconnected && <p className="mt-1 text-gray-300">Связь с сервером восстанавливается…</p>}
    </div>
    {plan && !active && <span aria-hidden="true" className="shrink-0 rounded-md bg-gray-700 px-2 py-1 font-medium tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>}
    {(completed || (standalone && snapshot && !plan)) && <button onClick={() => { window.location.href = standalone ? "/" : window.location.href; }} className="min-h-9 rounded-lg px-3 text-indigo-300 underline-offset-4 hover:bg-gray-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400">Продолжить</button>}
  </section>;
  return fullscreen ? createPortal(<div className="absolute inset-x-4 top-4 z-60">{notice}</div>, fullscreen) : notice;
}
