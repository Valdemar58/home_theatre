"use client";
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon, PlayIcon, SpeakerWaveIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, cancelAutoTask, startTask, useMe, useVoices } from "@/lib/client";
import type { MediaLite } from "@/lib/types";
import type { RuRelease } from "@/server/ru/releases";
import { Badge, Button, cx, EmptyState, ErrorBox, Modal, Spinner } from "./ui";

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} ГБ`;

type Action = "download" | "stream";

const KIND_LABELS: Record<string, string> = { Dub: "Дубляж", MVO: "Многоголосая", DVO: "Двухголосая", VO: "Одноголосая" };

function episodesText(r: RuRelease): string | null {
  if (!r.episodes) return null;
  const range = r.episodes.from === r.episodes.to ? `${r.episodes.to}` : `${r.episodes.from}–${r.episodes.to}`;
  if (r.total) return `${range} из ${r.total}${r.complete ? "" : " (выходит)"}`;
  return `серии ${range}`;
}

/**
 * Кнопка «Озвучки»: список русских раздач тайтла и скачивание выбранной.
 * Поиск идёт фоновой задачей: окно можно закрыть, по готовности придёт уведомление.
 * autoFetch (страница тайтла) — начать поиск сразу при открытии страницы; ушли, не нажав, — отмена.
 * initialOpen — открыть окно сразу; число — открыть при каждом его изменении («Найти серию» у кнопки «Смотреть»).
 */
export function VoicesButton({ media, size = "md", autoFetch, initialOpen }: {
  media: MediaLite;
  size?: "sm" | "md";
  autoFetch?: boolean;
  initialOpen?: boolean | number;
}) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(Boolean(initialOpen));
  const enabled = Boolean(me?.ru.configured) && media.format !== "MOVIE";
  const qc = useQueryClient();
  const clicked = useRef(false);
  const { data: state } = useVoices(media.id, enabled && (open || Boolean(autoFetch)));

  useEffect(() => {
    if (!enabled || !autoFetch) return;
    void startTask("voices", media.id, "auto").then(() => qc.invalidateQueries({ queryKey: ["voices", media.id] })).catch(() => undefined);
    const leave = () => { if (!clicked.current) cancelAutoTask("voices", media.id); };
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); };
  }, [enabled, autoFetch, media.id, qc]);

  useEffect(() => {
    if (!initialOpen) return;
    clicked.current = true;
    setOpen(true);
  }, [initialOpen]);

  if (!enabled) return null;
  const busy = state?.task && ["queued", "running"].includes(state.task.status);
  const count = state?.data?.releases.length;
  return (
    <>
      <Button size={size} onClick={() => { clicked.current = true; setOpen(true); }}
        title={busy ? "Ищу раздачи в фоне" : "Выбрать раздачу с нужной озвучкой"}>
        {busy ? <Spinner className="h-4 w-4 text-gray-300" /> : <SpeakerWaveIcon className="h-4 w-4" />} Озвучки
        {count ? <span className="text-gray-400">· {count}</span> : null}
      </Button>
      {open && <VoicesDialog media={media} onClose={() => setOpen(false)} />}
    </>
  );
}

const ago = (unix: number) => {
  const m = Math.round((Date.now() / 1000 - unix) / 60);
  return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} д назад`;
};

function VoicesDialog({ media, onClose }: { media: MediaLite; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: state, error, isLoading } = useVoices(media.id, true);
  const { data: me } = useMe();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ guid: string; action: Action; ok: boolean; message: string; url?: string | null } | null>(null);
  const data = state?.data;
  const task = state?.task;
  const searching = task && ["queued", "running"].includes(task.status);
  const stale = !state?.fetchedAt || state.fetchedAt < Date.now() / 1000 - 6 * 3600;

  // Открыли окно: результата нет или он старый — ставим поиск (ручной: придёт уведомление)
  const asked = useRef(false);
  useEffect(() => {
    if (!state || asked.current) return;
    if (searching ? task.origin !== "user" : stale || task?.status === "error") {
      asked.current = true;
      void startTask("voices", media.id, "user").then(() => qc.invalidateQueries({ queryKey: ["voices", media.id] }));
    }
  }, [state, searching, stale, task, media.id, qc]);
  // Поиск закончился — показать свежий результат
  const wasSearching = useRef(false);
  useEffect(() => {
    if (searching) wasSearching.current = true;
    else if (wasSearching.current) { wasSearching.current = false; void qc.invalidateQueries({ queryKey: ["voices", media.id] }); }
  }, [searching, media.id, qc]);
  const refresh = () => {
    asked.current = true;
    void startTask("voices", media.id, "user").then(() => qc.invalidateQueries({ queryKey: ["voices", media.id] }));
  };

  const run = async (r: RuRelease, action: Action) => {
    setBusy(`${r.guid}:${action}`);
    setResult(null);
    try {
      const path = action === "stream" ? `/api/ru/releases/${media.id}/stream` : `/api/ru/releases/${media.id}`;
      const res = await api<{ ok: boolean; message: string }>(path, { method: "POST", json: { guid: r.guid } });
      setResult({ guid: r.guid, action, ...res });
      if (action === "download") qc.invalidateQueries({ queryKey: ["seerr", media.id] });
      // Ждём, пока Jellyfin отсканирует новый сериал, и показываем ссылку на него
      if (action === "stream" && res.ok) {
        for (let i = 0; i < 12; i++) {
          await new Promise((ok) => setTimeout(ok, 5000));
          const { url } = await api<{ url: string | null }>(`/api/ru/releases/${media.id}/stream`).catch(() => ({ url: null }));
          if (url) {
            setResult((prev) => (prev && prev.guid === r.guid ? { ...prev, url } : prev));
            break;
          }
        }
      }
    } catch (err) {
      setResult({ guid: r.guid, action, ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Раздачи с русской озвучкой" wide>
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-gray-400">
          {task?.status === "error" ? (
            <><ErrorBox error={task.error} /><Button size="sm" onClick={refresh}>Повторить</Button></>
          ) : (
            <>
              <Spinner className="h-8 w-8" />
              <p className="text-gray-200">Ищу раздачи на RuTracker и читаю описания — это фоновая задача.</p>
              <p>Окно можно закрыть: когда всё будет готово, придёт уведомление, и озвучки откроются сразу.</p>
            </>
          )}
        </div>
      ) : !data?.releases.length ? (
        <EmptyState title="Русских раздач не нашлось">
          Возможно, тайтл ещё не озвучили или он называется на трекере иначе.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            Отсортировано по твоим приоритетам из profiles.toml (★ — баллы, как их посчитает Sonarr).
            {!data.inSonarr && " Сериала пока нет в Sonarr: он будет добавлен, скачается только выбранная раздача."}
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-gray-900/60 px-3 py-2 text-xs text-gray-400 ring-1 ring-gray-700">
            {searching
              ? <><Spinner className="h-4 w-4" /> Обновляю в фоне — список сменится сам, окно можно закрыть.</>
              : <>Найдено {state?.fetchedAt ? ago(state.fetchedAt) : ""}{data.pending > 0 && ` · ещё ${data.pending} описаний не дочитано`}</>}
            {!searching && <Button size="sm" variant="ghost" className="ml-auto" onClick={refresh}>Обновить</Button>}
          </div>
          {data.releases.map((r) => (
            <div key={r.guid} className={cx("rounded-lg bg-gray-900/60 p-3 ring-1", result?.guid === r.guid && result.ok ? "ring-green-500" : "ring-gray-700")}>
              <div className="flex flex-wrap items-center gap-1.5">
                {r.voices.length
                  ? r.voices.map((v) => <Badge key={v} tone="accent">{v}</Badge>)
                  : <span className="text-sm text-gray-500">студии не указаны</span>}
                {r.kinds.map((k) => <Badge key={k}>{KIND_LABELS[k] ?? k}</Badge>)}
                {r.rus === "int" && <Badge tone="positive">RU в файле</Badge>}
                {r.rus === "ext" && <Badge tone="warning">RU отдельными файлами</Badge>}
                {r.score > 0 && (
                  <span className="ml-auto text-sm font-semibold text-yellow-300" title={r.matched.join(", ")}>★ {r.score}</span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-300">
                <span>{r.quality}{r.hdr ? " HDR" : ""}</span>
                {episodesText(r) && <span>{episodesText(r)}</span>}
                <span>{gb(r.size)}</span>
                <span className={r.seeders > 0 ? "text-green-400" : "text-red-400"}>▲ {r.seeders}</span>
                {r.langs.length > 0 && <span className="text-gray-500">{r.langs.join(", ")}</span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-xs text-gray-500" title={r.title}>{r.title}</p>
                {r.infoUrl && (
                  <a href={r.infoUrl} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-white" title="Открыть раздачу">
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  </a>
                )}
                {me?.ru.stream && (
                  <Button size="sm" onClick={() => run(r, "stream")} disabled={Boolean(busy)}
                    title={r.rus === "ext" ? "Русская озвучка в этой раздаче отдельными файлами — онлайн её не будет, только скачать" : "Смотреть сразу, не дожидаясь загрузки"}>
                    <PlayIcon className="h-4 w-4" /> {busy === `${r.guid}:stream` ? "Готовлю…" : "Смотреть"}
                  </Button>
                )}
                <Button size="sm" variant="primary" onClick={() => run(r, "download")}
                  disabled={Boolean(busy) || (result?.guid === r.guid && result.action === "download" && result.ok)}>
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  {busy === `${r.guid}:download` ? "Отправка…" : result?.guid === r.guid && result.action === "download" && result.ok ? "В загрузке" : "Скачать"}
                </Button>
              </div>
              {me?.ru.stream && r.rus === "ext" && (
                <p className="mt-1 text-xs text-yellow-300/80">Русская озвучка здесь отдельными файлами: онлайн будет только оригинал, для озвучки — «Скачать».</p>
              )}
              {result?.guid === r.guid && (
                <div className={cx("mt-2 text-sm", result.ok ? "text-green-300" : "text-red-300")}>
                  {result.message}
                  {result.ok && <Link href="/downloads" className="ml-2 text-indigo-300 underline">Прогресс и отмена — в «Загрузках»</Link>}
                  {result.action === "stream" && result.ok && (
                    result.url
                      ? <a href={result.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold text-indigo-300 underline">Открыть в Jellyfin <ArrowTopRightOnSquareIcon className="h-4 w-4" /></a>
                      : <span className="ml-2 text-gray-400">Jellyfin сканирует библиотеку…</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
