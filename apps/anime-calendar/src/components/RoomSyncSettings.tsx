"use client";
import { useState } from "react";
import { DEFAULT_SYNC_POLICY, syncCorrection, syncPolicy, type SyncPolicy } from "@/lib/sync-policy";
import { Button, ErrorBox } from "./ui";
const fields = [
  ["tolerance", "Допустимое расхождение, с", 0.05, 2, 0.05],
  ["maxRate", "Максимальное ускорение, ×", 1, 1.25, 0.01],
  ["minRate", "Минимальная скорость опережающего, ×", 0.85, 1, 0.01],
  ["settleSeconds", "Темп коррекции, с", 1, 60, 1],
  ["hardSeek", "Перемотка при расхождении больше, с", 1, 30, 0.5],
] as const;
export function RoomSyncSettings({ policy = DEFAULT_SYNC_POLICY, owner, save }: { policy?: SyncPolicy; owner: boolean; save: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [draft, setDraft] = useState<SyncPolicy | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [saved, setSaved] = useState(false);
  const value = draft ?? policy;
  let valid: SyncPolicy | null = null; try { valid = syncPolicy(value); } catch { /* validation shown on save */ }
  return <section className="space-y-4 border-t border-gray-700 pt-5">
    <div><h3 className="font-medium">Синхронизация просмотра</h3><p className="mt-1 max-w-2xl text-sm text-gray-400">Одна политика для всех устройств комнаты, включая fullscreen и мини-плеер. Небольшое отставание исправляется скоростью; большое — перемоткой.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">{fields.map(([key, label, min, max, step]) => <label key={key} className="flex min-w-0 flex-col gap-1 text-sm"><span>{label}</span><input type="number" min={min} max={max} step={step} disabled={!owner || busy} value={value[key]} onChange={e => { setDraft({ ...value, [key]: e.target.valueAsNumber }); setSaved(false); }} className="min-h-11 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-base tabular-nums focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-60" /></label>)}
      <label className="flex min-w-0 flex-col gap-1 text-sm"><span>Кривая изменения скорости</span><select disabled={!owner || busy} value={value.curve} onChange={e => { setDraft({ ...value, curve: e.target.value as SyncPolicy["curve"] }); setSaved(false); }} className="min-h-11 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-base focus-visible:outline-2 focus-visible:outline-accent-400"><option value="linear">Линейная</option><option value="smooth">Плавная</option></select></label>
    </div>
    <p className="text-sm text-gray-400">Меньше «Темп коррекции» — быстрее догоняем. Линейная кривая пропорциональна отставанию, плавная мягко приближается к пределу. При малом буфере ускорение приостанавливается.</p>
    {valid && <p className="text-sm tabular-nums text-gray-300">При отставании 1 с: {syncCorrection(-1, true, valid).rate.toFixed(3)}× · при 2 с: {syncCorrection(-2, true, valid).rate.toFixed(3)}×</p>}
    {error ? <ErrorBox error={error} /> : null}
    {owner && <div className="flex flex-wrap items-center gap-3"><Button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { const clean = syncPolicy(value); if (await save({ action: "sync-policy", policy: clean })) { setDraft(null); setSaved(true); } } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? "Сохраняем…" : "Сохранить синхронизацию"}</Button><Button variant="ghost" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_SYNC_POLICY }); setSaved(false); }}>По умолчанию</Button>{saved && <span role="status" className="text-sm text-positive-300">Сохранено для комнаты</span>}</div>}
  </section>;
}
