"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { canControl, clockOffset, type RoomView } from "@/lib/room";
import type { RoomConnection } from "@/lib/connection-diagnostics";

// Комната на странице просмотра: снимок по SSE (сам переподключается), команды, отчёт плеера и часы сервера
// (сдвиг по самому быстрому из последних замеров — у медленного ответа середина запроса неточна).

export type RoomHandle = {
  room: RoomView | null;
  /** Комната закончилась (или нас в ней больше нет) */
  ended: boolean;
  connected: boolean;
  connection: RoomConnection;
  canControl: boolean;
  act: (body: Record<string, unknown>) => Promise<RoomView | null>;
  report: (r: { playbackError?: boolean; buffering: boolean; bw: number | null; drift: number | null; position?: number; buffered?: [number, number][]; anilistId?: number; ep?: number; revision?: number }) => void;
  serverNow: () => number;
  rtt: number | null;
};

export function useRoom(rid: string | null): RoomHandle {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [ended, setEnded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<RoomConnection>({ transport: "connecting", lastSnapshot: 0, lastError: null });
  const offset = useRef(0);
  const samples = useRef<{ d: number; off: number }[]>([]);
  const [rtt, setRtt] = useState<number | null>(null);
  const rttRef = useRef<number | null>(null);
  const meJoined = room?.members.find((m) => m.id === room.me)?.status === "joined";

  useEffect(() => { setRoom(null); setEnded(false); setConnected(false); setConnection({ transport: "connecting", lastSnapshot: 0, lastError: null }); samples.current = []; }, [rid]);
  // Поток событий; вошли в комнату — переподключиться (теперь «в сети»)
  useEffect(() => {
    if (!rid) return;
    let alive = true, polling = false, lastSse = 0, lastSnapshot = 0, lastServerTime = 0;
    const controller = new AbortController();
    const receive = (d: (RoomView & { now: number }) | { id: string; ended: true }, sse: boolean) => {
      if (!alive) return;
      if (sse) lastSse = Date.now();
      lastSnapshot = Date.now(); setConnected(true);
      setConnection({ transport: sse ? "sse" : "poll", lastSnapshot, lastError: null });
      if ("members" in d) {
        if (d.now < lastServerTime) return;
        lastServerTime = d.now;
        if (!samples.current.length) offset.current = d.now - Date.now();
        setRoom(prev => prev?.id === d.id && (prev.state.session?.revision ?? prev.state.generation ?? 0) > (d.state.session?.revision ?? d.state.generation ?? 0) ? prev : d);
        setEnded(d.ended);
      } else setEnded(true);
    };
    const es = new EventSource(`/api/rooms/${rid}/events`);
    es.onerror = () => { lastSse = 0; };
    es.onmessage = (e) => {
      const d = JSON.parse(e.data) as (RoomView & { now: number }) | { id: string; ended: true };
      receive(d, true);
    };
    const poll = async () => {
      if (!alive || polling || Date.now() - lastSse < 2500) return;
      polling = true; const t0 = Date.now();
      try {
        const d = await api<RoomView & { now: number }>(`/api/rooms/${rid}?poll=1`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        const t1 = Date.now(); if (!alive) return;
        samples.current = [...samples.current.slice(-7), { d: t1 - t0, off: clockOffset(t0, t1, d.now) }];
        offset.current = samples.current.reduce((a, b) => a.d < b.d ? a : b).off;
        receive(d, false);
      } catch (e) { if (alive) { setConnection(prev => ({ ...prev, lastError: ["TimeoutError", "AbortError"].includes((e as Error).name) ? "timeout" : "request" })); if (Date.now() - lastSnapshot > 6500) setConnected(false); } }
      finally { polling = false; }
    };
    const timer = setInterval(() => { if (Date.now() - lastSnapshot > 6500) { setConnected(false); setConnection(prev => prev.transport === "offline" ? prev : { ...prev, transport: "offline" }); } void poll(); }, 1000);
    void poll();
    const wake = () => { if (!document.hidden) { lastSse = 0; void poll(); } };
    document.addEventListener("visibilitychange", wake); window.addEventListener("online", wake);
    return () => { alive = false; controller.abort(); clearInterval(timer); es.close(); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [rid, meJoined]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    if (!rid) return null;
    const r = await api<RoomView>(`/api/rooms/${rid}`, { method: "POST", json: body, signal: AbortSignal.timeout(8000) });
    setRoom(prev => prev?.id === r.id && (prev.state.session?.revision ?? prev.state.generation ?? 0) > (r.state.session?.revision ?? r.state.generation ?? 0) ? prev : r);
    return r;
  }, [rid]);

  const report = useCallback((r: { playbackError?: boolean; buffering: boolean; bw: number | null; drift: number | null; position?: number; buffered?: [number, number][]; anilistId?: number; ep?: number; revision?: number }) => {
    if (!rid) return;
    const t0 = Date.now();
    void api<{ now: number }>(`/api/rooms/${rid}`, { method: "POST", json: { action: "report", ...r, rtt: rttRef.current } }).then(({ now }) => {
      const t1 = Date.now();
      samples.current = [...samples.current.slice(-7), { d: t1 - t0, off: clockOffset(t0, t1, now) }];
      const best = samples.current.reduce((a, b) => (b.d < a.d ? b : a));
      offset.current = best.off;
      const avg = Math.round(samples.current.reduce((s, x) => s + x.d, 0) / samples.current.length);
      rttRef.current = avg;
      setRtt(avg);
    }).catch(() => undefined);
  }, [rid]);

  const serverNow = useCallback(() => Date.now() + offset.current, []);
  const me = room?.members.find((m) => m.id === room.me);
  return { room, ended, connected, connection, canControl: Boolean(room && connected && !ended && canControl(room.preset, me)), act, report, serverNow, rtt };
}
