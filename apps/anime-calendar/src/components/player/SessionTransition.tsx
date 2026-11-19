"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { nextSessionItem } from "@/lib/session-playback";
import { Button } from "../ui";
import type { RoomHandle } from "./useRoom";

/** Lives inside the persistent fullscreen root, including while the next player is loading. */
export function SessionTransition({ handle, nextTitle }: { handle: RoomHandle; nextTitle: string }) {
  const plan = handle.room?.state.session;
  const [now, setNow] = useState(handle.serverNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(handle.serverNow()), 250);
    return () => clearInterval(timer);
  }, [handle.serverNow]);
  if (!plan || plan.phase === "watching") return null;
  const seconds = Math.max(0, Math.ceil(((plan.deadline ?? now) - now) / 1000));
  const next = nextSessionItem(plan);
  const waiting = !plan.autoplay || seconds === 0;
  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await handle.act({ ...body, revision: plan.revision }); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось изменить переход. Повторите попытку."); }
    finally { setBusy(false); }
  };
  if (plan.phase === "next") return <section aria-label="Переход по плану сеанса" className="session-transition absolute inset-x-2 bottom-14 z-40 space-y-2 rounded-xl bg-gray-950 p-3 sm:inset-x-auto sm:bottom-20 sm:right-4 sm:w-96">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Следующая · {next?.ep} серия</h2>
        <p className="truncate text-xs text-gray-300" title={nextTitle}>{nextTitle}</p>
      </div>
      <span className="text-2xl font-medium tabular-nums text-accent-200" role="timer" aria-label="Осталось до перехода">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
    </div>
    {(!handle.connected || !plan.autoplay || plan.blocked) && <p role="status" className="text-xs text-gray-300">{!handle.connected ? "Восстанавливаем связь…" : plan.blocked ?? "Ожидание организатора"}</p>}
    {handle.canControl && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void run({ action: "session-next" })}>Смотреть сейчас</Button>
      <Button size="sm" disabled={busy} onClick={() => void run({ action: "session-autoplay", enabled: !plan.autoplay })} aria-label={plan.autoplay ? "Отменить переход" : "Включить автовоспроизведение"}>{plan.autoplay ? "Отменить переход" : "Автопереход"}</Button>
    </div>}
    {error && <p role="alert" className="text-xs text-negative-300">{error}</p>}
  </section>;
  return <div className="session-transition absolute inset-0 z-40 flex justify-center overflow-y-auto bg-gray-950 p-3 sm:p-6">
    <section className="my-auto w-full max-w-lg space-y-2 text-center sm:space-y-4" aria-label="Переход по плану сеанса">
      <h2 className="text-lg font-semibold sm:text-2xl">{plan.phase === "complete" ? "Сеанс завершён" : "Перерыв между тайтлами"}</h2>
      {plan.phase === "complete" ? <><p className="text-sm text-gray-300">План сеанса завершён. Личный прогресс каждого участника сохраняется отдельно.</p>{handle.room?.groupId && <Link href={`/groups/${handle.room.groupId}`} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-accent-200 hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-accent-300">Вернуться в комнату</Link>}</> : <>
        <p className="text-sm text-gray-300">{nextTitle} · {next?.ep} серия</p>
        <div className="text-4xl font-medium tabular-nums text-accent-200 sm:text-6xl" role="timer" aria-label="Осталось до перехода">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</div>
        <p className="text-sm text-gray-300" role="status">{!handle.connected ? "Связь с комнатой потеряна. Восстанавливаем подключение…" : plan.blocked ?? (waiting ? (plan.autoplay ? "Переходим к просмотру…" : "Ожидание организатора") : "Просмотр продолжится автоматически")}</p>
        {handle.canControl && <div className="flex flex-wrap items-center justify-center gap-3">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void run({ action: "session-next" })}>Смотреть сейчас</Button>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" className="h-4 w-4 accent-accent-500" checked={plan.autoplay} disabled={busy} onChange={e => void run({ action: "session-autoplay", enabled: e.target.checked })} />
            Автовоспроизведение
          </label>
        </div>}
      </>}
      {error && <p role="alert" className="text-sm text-negative-300">{error}</p>}
    </section>
  </div>;
}
