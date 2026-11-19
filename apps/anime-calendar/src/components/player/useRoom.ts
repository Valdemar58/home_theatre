"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { canControl, clockOffset, type RoomView } from "@/lib/room";

// Комната на странице просмотра: снимок по SSE (сам переподключается), команды, отчёт плеера и часы сервера
// (сдвиг по самому быстрому из последних замеров — у медленного ответа середина запроса неточна).

export type RoomHandle = {
  room: RoomView | null;
  /** Комната закончилась (или нас в ней больше нет) */
  ended: boolean;
  connected: boolean;
  canControl: boolean;
  act: (body: Record<string, unknown>) => Promise<RoomView | null>;
  report: (r: { buffering: boolean; bw: number | null; drift: number | null; position?: number; buffered?: [number, number][]; anilistId?: number; ep?: number; revision?: number }) => void;
  serverNow: () => number;
  rtt: number | null;
};

export function useRoom(rid: string | null): RoomHandle {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [ended, setEnded] = useState(false);
  const [connected, setConnected] = useState(false);
  const offset = useRef(0);
  const samples = useRef<{ d: number; off: number }[]>([]);
  const [rtt, setRtt] = useState<number | null>(null);
  const rttRef = useRef<number | null>(null);
  const meJoined = room?.members.find((m) => m.id === room.me)?.status === "joined";

  useEffect(() => { setRoom(null); setEnded(false); setConnected(false); samples.current = []; }, [rid]);
  // Поток событий; вошли в комнату — переподключиться (теперь «в сети»)
  useEffect(() => {
    if (!rid) return;
    const es = new EventSource(`/api/rooms/${rid}/events`);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      setConnected(true);
      const d = JSON.parse(e.data) as (RoomView & { now: number }) | { id: string; ended: true };
      if ("members" in d) {
        // Первый снимок — грубая оценка часов, пока нет замеров
        if (!samples.current.length) offset.current = d.now - Date.now();
        setRoom(prev => prev?.id === d.id && (prev.state.session?.revision ?? prev.state.generation ?? 0) > (d.state.session?.revision ?? d.state.generation ?? 0) ? prev : d);
        setEnded(d.ended);
      } else setEnded(true);
    };
    return () => es.close();
  }, [rid, meJoined]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    if (!rid) return null;
    const r = await api<RoomView>(`/api/rooms/${rid}`, { method: "POST", json: body });
    setRoom(prev => prev?.id === r.id && (prev.state.session?.revision ?? prev.state.generation ?? 0) > (r.state.session?.revision ?? r.state.generation ?? 0) ? prev : r);
    return r;
  }, [rid]);

  const report = useCallback((r: { buffering: boolean; bw: number | null; drift: number | null; position?: number; buffered?: [number, number][]; anilistId?: number; ep?: number; revision?: number }) => {
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
  return { room, ended, connected, canControl: Boolean(room && connected && !ended && canControl(room.preset, me)), act, report, serverNow, rtt };
}
