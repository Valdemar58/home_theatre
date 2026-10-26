"use client";
import { ArrowDownTrayIcon, CheckCircleIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, useMe, useSeerr } from "@/lib/client";
import type { MediaLite, SeerrStatus } from "@/lib/types";
import { Badge, Button, ErrorBox, Modal, Spinner } from "./ui";

// Статусы медиа в Seerr
const AVAILABLE = 5;
const PARTIAL = 4;
const PROCESSING = 3;
const PENDING = 2;

function StatusBadge({ status }: { status: number }) {
  if (status === AVAILABLE) return <Badge tone="positive">Есть в Jellyfin</Badge>;
  if (status === PARTIAL) return <Badge tone="positive">Частично</Badge>;
  if (status === PROCESSING) return <Badge tone="accent">Загружается</Badge>;
  if (status === PENDING) return <Badge tone="warning">Ожидает одобрения</Badge>;
  return null;
}

/** Становится true, когда элемент впервые попал в область видимости. */
function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

export function RequestButton({ media, size = "md" }: { media: MediaLite; size?: "sm" | "md" }) {
  const { data: me } = useMe();
  const configured = Boolean(me?.seerr.configured);
  // Статус в Seerr запрашиваем только у видимых карточек: в ленте их десятки
  const { ref, seen } = useInView<HTMLSpanElement>();
  const { data, isLoading, error } = useSeerr(media.id, configured && seen);
  const [open, setOpen] = useState(false);

  if (!configured) return null;
  // Пока статус неизвестен — та же кнопка, неактивная, с индикатором: интерфейс не прыгает
  if (!seen || isLoading) {
    return (
      <span ref={ref} className="inline-flex">
        <Button variant="primary" size={size} disabled><Spinner className="h-4 w-4 text-white" /> Запросить</Button>
      </span>
    );
  }
  if (error || !data) return null;
  if (!data.found) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400" title="Тайтл не найден в TMDB/Seerr">
        <ExclamationTriangleIcon className="h-4 w-4" /> Нет в Seerr
      </span>
    );
  }
  const status = data.status ?? 1;
  if (status === AVAILABLE) {
    return (
      <a href={data.url} target="_blank" rel="noreferrer">
        <Button variant="success" size={size}><CheckCircleIcon className="h-4 w-4" /> В Jellyfin</Button>
      </a>
    );
  }
  if (status === PROCESSING || status === PENDING) {
    return (
      <a href={data.url} target="_blank" rel="noreferrer">
        <Button size={size}><ClockIcon className="h-4 w-4" /> {status === PENDING ? "Запрошено" : "Загружается"}</Button>
      </a>
    );
  }
  return (
    <>
      <Button variant="primary" size={size} onClick={() => setOpen(true)}>
        <ArrowDownTrayIcon className="h-4 w-4" /> {status === PARTIAL ? "Запросить ещё" : "Запросить"}
      </Button>
      <RequestDialog open={open} onClose={() => setOpen(false)} media={media} status={data} />
    </>
  );
}

function RequestDialog({ open, onClose, media, status }: { open: boolean; onClose: () => void; media: MediaLite; status: SeerrStatus }) {
  const qc = useQueryClient();
  const requestable = (status.seasons ?? []).filter((s) => s.status < PENDING);
  const [selected, setSelected] = useState<number[]>(() =>
    status.suggestedSeason && requestable.some((s) => s.seasonNumber === status.suggestedSeason) ? [status.suggestedSeason] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (n: number) => setSelected((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(`/api/seerr/${media.id}`, { method: "POST", json: { seasons: selected } });
      setDone(res.message);
      qc.invalidateQueries({ queryKey: ["seerr", media.id] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Запросить: ${status.title ?? ""}`}>
      {done ? (
        <div className="space-y-4">
          <p className="text-green-300">{done}. Seerr передаст запрос в Sonarr/Radarr, загрузка начнётся автоматически.</p>
          <Button onClick={onClose}>Закрыть</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {status.matchedBy === "search" && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">
              Тайтл найден поиском по названию, а не по точному соответствию.{" "}
              <a href={status.url} target="_blank" rel="noreferrer" className="underline">Проверь в Seerr</a>, тот ли это сериал.
            </div>
          )}
          {status.mediaType === "tv" ? (
            <>
              <p className="text-sm text-gray-400">
                Сезоны в TMDB не всегда совпадают с сезонами аниме. Отмечен сезон, который соответствует этому тайтлу.
              </p>
              <div className="divide-y divide-gray-700 overflow-hidden rounded-lg ring-1 ring-gray-700">
                {(status.seasons ?? []).map((s) => {
                  const disabled = s.status >= PENDING;
                  return (
                    <label key={s.seasonNumber}
                      className={`flex items-center justify-between gap-3 px-4 py-2.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-gray-700/50"}`}>
                      <span className="flex items-center gap-3">
                        <input type="checkbox" className="h-4 w-4 accent-indigo-500" disabled={disabled}
                          checked={selected.includes(s.seasonNumber)} onChange={() => toggle(s.seasonNumber)} />
                        <span>
                          {s.name || `Сезон ${s.seasonNumber}`}
                          <span className="ml-2 text-xs text-gray-400">{s.episodeCount} эп.</span>
                        </span>
                      </span>
                      <StatusBadge status={s.status} />
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-300">Фильм будет отправлен в Radarr.</p>
          )}
          {error ? <ErrorBox error={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" onClick={submit} disabled={busy || (status.mediaType === "tv" && !selected.length)}>
              {busy ? "Отправка…" : "Запросить"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
