"use client";
import { api } from "@/lib/client";
import { Button, ErrorBox } from "../ui";
import { useState } from "react";
export type DesktopSources = { selected: string | null; active: string | null; relayEnabled?: boolean; hosts: { id: string; name: string; label: string; online: boolean; files: { id: string; ep: number; preparedVersion: string; preparedBytes: number }[] }[] };
export function DesktopSource({ room, ep, data, canControl, refresh }: { room: string; ep: number; data?: DesktopSources; canControl: boolean; refresh: () => void }) {
  const [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  async function select(device: string | null) {
    setBusy(true); setError(null);
    try { await api("/api/desktop/stream", { method: "POST", json: { action: "select", room, device } }); refresh(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl bg-gray-800/40 p-4">
    <h3 className="font-semibold">Источник комнаты</h3>
    <label className="block space-y-1 text-sm"><span className="text-gray-400">Хост серии</span>
      <select aria-label="Хост серии" className="w-full min-w-0 rounded-lg border border-gray-600 bg-gray-900 p-2 text-sm focus-visible:outline-accent-400" disabled={!canControl || busy || !data} value={data?.selected || ""} onChange={e => void select(e.target.value || null)}>
        <option value="">Серверная библиотека / раздача</option>
        {data?.hosts.map(h => <option key={h.id} value={h.id} disabled={!h.online || !h.files.some(f => f.ep === ep)}>{h.name} · {h.label}{!h.online ? " · офлайн" : !h.files.some(f => f.ep === ep) ? " · серия не готова" : ""}</option>)}
        {data?.selected && !data.hosts.some(h => h.id === data.selected) && <option value={data.selected}>Хост недоступен</option>}
      </select>
    </label>
    {data?.active && data.active !== data.selected && <p className="text-xs text-gray-300">Передаёт {data.hosts.find(h => h.id === data.active)?.label || "запасной хост"} · та же версия файла</p>}
    {!canControl && <p className="text-xs text-gray-400">Источник выбирает участник с правом управления.</p>}
    {data?.selected && <p className="text-xs text-gray-400">Desktop должен оставаться открытым. {data.relayEnabled === false ? "Доступно только прямое соединение; некоторые мобильные сети и VPN могут его блокировать." : "При недоступности прямого канала используется серверная ретрансляция."}</p>}
    {error ? <ErrorBox error={error} /> : null}
    {data?.selected && canControl && <Button size="sm" disabled={busy} onClick={() => void select(null)}>Вернуться к серверному источнику</Button>}
  </section>;
}
