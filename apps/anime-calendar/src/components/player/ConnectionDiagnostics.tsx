"use client";
import { useState } from "react";
import type { RoomConnection } from "@/lib/connection-diagnostics";
import type { DesktopDiagnostics } from "@/lib/desktop-transport";
import { Button } from "../ui";

export function ConnectionDiagnostics({ room, media, sourceError, element }: { room: RoomConnection; media: DesktopDiagnostics | null; sourceError: boolean; element?: () => Record<string, number | boolean | null> | null }) {
  const [report, setReport] = useState(""), [copied, setCopied] = useState(false);
  const p = media?.progress;
  const connected = room.transport === "sse" || room.transport === "poll";
  const summary = !connected ? "Нет связи с комнатой" : sourceError ? "Комната доступна, источник не получен" : !p ? "Комната доступна, подключаем видео" : p.signaling === "timeout" || p.signaling === "error" ? "Не отвечает сигнализация видеоканала" : p.browser === "unsupported" ? "Браузер не подключил видеоканал" : p.hostOnline === false ? "Desktop-хост не отвечает серверу" : !p.offerSent ? "Согласовываем соединение" : !p.answerReceived ? "Ожидаем ответ desktop-хоста" : p.channel !== "open" ? "Проверяем прямое соединение ICE" : p.packets === 0 ? "Прямой канал открыт, ожидаем данные" : "Комната и видеоканал подключены";
  const candidates = (c: NonNullable<typeof p>["localCandidates"]) => `host ${c.host} · srflx ${c.srflx} · prflx ${c.prflx} · relay ${c.relay}`;
  return <details className="rounded-xl bg-gray-800/40 p-3 text-sm text-gray-300 ring-1 ring-gray-700">
    <summary className="cursor-pointer rounded-sm text-gray-200 focus-visible:outline-2 focus-visible:outline-accent-400">Диагностика подключения <span className="ml-1 text-gray-400">· {summary}</span></summary>
    <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 break-words text-xs sm:text-sm">
      <dt className="text-gray-400">Комната</dt><dd>{room.transport === "sse" ? "Подключена · SSE" : room.transport === "poll" ? "Подключена · резервный опрос" : room.transport === "offline" ? "Нет свежих данных" : "Подключаемся"}{room.lastError && ` · ${room.lastError === "timeout" ? "тайм-аут API" : "ошибка запроса API"}`}</dd>
      <dt className="text-gray-400">Последние данные</dt><dd>{room.lastSnapshot ? new Date(room.lastSnapshot).toLocaleTimeString("ru-RU") : "Ещё не получены"}</dd>
      <dt className="text-gray-400">Сигнализация</dt><dd>{p ? `${p.signaling} · хост ${p.hostOnline === null ? "проверяется" : p.hostOnline ? "доступен" : "не отвечает"}` : sourceError ? "Не удалось получить источник" : "Ещё не запущена"}</dd>
      {p && <><dt className="text-gray-400">Обмен с хостом</dt><dd>Предложение {p.offerSent ? "отправлено" : "не отправлено"} · ответ {p.answerReceived ? "получен" : "не получен"}</dd>
        <dt className="text-gray-400">ICE / канал</dt><dd>{p.ice} / {p.channel} · сбор {p.gathering}</dd>
        <dt className="text-gray-400">Адреса зрителя</dt><dd>{candidates(p.localCandidates)}</dd>
        <dt className="text-gray-400">Адреса хоста</dt><dd>{candidates(p.remoteCandidates)}</dd>
        <dt className="text-gray-400">Передача</dt><dd className="tabular-nums">{p.packets} пакетов · напрямую {((media?.directBytes ?? 0) / 1048576).toFixed(2)} МиБ · через сервер {((media?.relayBytes ?? 0) / 1048576).toFixed(2)} МиБ</dd></>}
    </dl>
    <p className="mt-3 text-xs text-gray-400">Отчёт содержит состояния и количество адресов, без IP, токенов и содержимого SDP.</p>
    <Button size="sm" className="mt-3" onClick={async () => {
      const text = JSON.stringify({ schema: 2, capturedAt: new Date().toISOString(), browser: navigator.userAgent, room, sourceError, element: element?.() ?? null, media: media ? { mode: media.mode, directBytes: media.directBytes, relayBytes: media.relayBytes, progress: p } : null }, null, 2);
      setReport(text); setCopied(false);
      try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* Selectable report below works when clipboard permission is unavailable. */ }
    }}>{copied ? "Отчёт скопирован" : "Скопировать отчёт"}</Button>
    {report && <label className="mt-3 block text-xs text-gray-400">{copied ? "Сохранённый снимок диагностики" : "Выделите и скопируйте отчёт вручную"}<textarea readOnly value={report} rows={8} onFocus={e => e.currentTarget.select()} className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-900 p-2 text-sm text-gray-200 focus-visible:outline-2 focus-visible:outline-accent-400" /></label>}
  </details>;
}
