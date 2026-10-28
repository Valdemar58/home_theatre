"use client";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { PlayStatus } from "@/lib/player";
import { waitText } from "@/lib/playback";
import { cx } from "../ui";

// Панель состояния потока поверх видео: что делает Jellyfin (какой сегмент готовит, сколько ждём), что перекодируется
// и как идёт раздача «Стрима» (то же, что на странице «Загрузки»). Видна, пока грузится, и по кнопке «i».

export type Stage = {
  step: "session" | "manifest" | "fragment" | "playing";
  since: number;
  /** Сегмент HLS, который сейчас грузится, и с какой секунды серии он начинается */
  sn?: number;
  at?: number;
  /** Последний загруженный сегмент: за сколько мс и сколько байт */
  lastMs?: number;
  lastBytes?: number;
};

const mb = (b: number) => `${(b / 1e6).toFixed(1)} МБ`;
const mbs = (b: number) => `${(b / 1e6).toFixed(1)} МБ/с`;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** Что Jellyfin делает с файлом — по причинам перекодирования. */
function transcodeText(reasons: string[]): string {
  if (!reasons.length) return "Файл идёт как есть";
  const video = reasons.some((r) => /Video|Bitrate|Level|Profile|Resolution|Framerate|BitDepth|Anamorphic|Interlaced|RefFrames/i.test(r) && !/Audio/i.test(r));
  const audio = reasons.some((r) => /Audio/i.test(r));
  if (video) return "Видео перекодируется в H.264 (NVENC)";
  return audio ? "Видео — как есть, звук перекодируется в AAC" : "Видео и звук — как есть, меняется только контейнер";
}

export function StreamStatus({ status, stage, transcode, stalled, compat, onRestart, onCompat, onClose }: {
  /** Раздача «Стрима» (опрашивает плеер); сессии ещё нет или файл из библиотеки — нет */
  status: PlayStatus | undefined; stage: Stage; transcode: string[] | null; stalled: boolean; compat: boolean;
  onRestart: () => void; onCompat: () => void; onClose?: () => void;
}) {
  // Тикает раз в секунду — «ждём N с»
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const waited = Math.max(0, (now - stage.since) / 1000);
  const s = status?.stream;

  const step = {
    session: "Запрашиваю поток у Jellyfin (он читает начало файла)…",
    manifest: "Jellyfin запускает перекодирование…",
    fragment: stage.sn !== undefined
      ? `Jellyfin готовит сегмент ${stage.sn}${stage.at !== undefined ? ` (с ${clock(stage.at)})` : ""}`
      : "Загружаю видео…",
    playing: "Идёт показ",
  }[stage.step];

  return (
    <div className="absolute left-3 top-10 z-20 w-80 max-w-[calc(100%-1.5rem)] space-y-1.5 rounded-lg bg-black/80 p-3 text-xs text-gray-200 shadow-xl ring-1 ring-white/10">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium text-white">
          {step}{stage.step !== "playing" && waited >= 2 ? <span className="font-normal text-gray-400"> · {Math.round(waited)} с</span> : null}
        </p>
        {onClose && <button onClick={onClose} aria-label="Скрыть" className="-m-1 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"><XMarkIcon className="h-4 w-4" /></button>}
      </div>
      {stage.lastMs !== undefined && stage.lastBytes !== undefined && (
        <p className="text-gray-400">Прошлый сегмент: {mb(stage.lastBytes)} за {(stage.lastMs / 1000).toFixed(1)} с</p>
      )}
      {transcode && <p className="text-gray-400">{transcodeText(transcode)}{compat ? " · совместимый режим" : ""}</p>}
      {s && (
        <div className="space-y-1 border-t border-white/10 pt-1.5">
          <p>
            Раздача: <span className="text-gray-400">{s.state}</span> · пиры {s.peers}{s.totalPeers ? ` из ${s.totalPeers}` : ""} · сиды {s.seeders}
          </p>
          <p className={cx(s.rate && s.speed > 0 ? (s.speed >= s.rate * 1.2 ? "text-positive-300" : "text-warning-300") : "text-gray-400")}>
            Скорость {mbs(s.speed)}{s.rate ? ` · нужно ~${mbs(s.rate)}` : ""}
            {s.rate && s.speed > 0 ? (s.speed >= s.rate * 1.2 ? " — хватает" : " — будут остановки") : ""}
          </p>
          {s.prebuffer && (
            <p className="text-gray-400">
              Подготовка: {Math.round((s.prebuffer.read / s.prebuffer.size) * 100)}%
              {s.prebuffer.done ? " — серия в кэше" : s.prebuffer.ready ? " — можно смотреть без остановок" : s.prebuffer.etaSec ? ` — без остановок через ~${waitText(s.prebuffer.etaSec)}` : ""}
            </p>
          )}
          {!s.prebuffer && s.rate && s.speed < s.rate * 1.2 && (
            <p className="text-gray-500">Серию можно подготовить заранее (молния у серии на странице тайтла).</p>
          )}
        </div>
      )}
      {stalled && (
        <div className="space-y-1.5 border-t border-white/10 pt-1.5">
          <p className="flex items-center gap-1.5 text-warning-300"><ExclamationTriangleIcon className="h-4 w-4" /> Картинка не пошла за 20 с</p>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={onRestart} className="rounded-md bg-white/10 px-2 py-1 hover:bg-white/20">Перезапустить</button>
            {!compat && (
              <button onClick={onCompat} className="rounded-md bg-white/10 px-2 py-1 hover:bg-white/20" title="Видео всегда перекодируется в H.264: помогает, если браузер не тянет HEVC">
                Совместимый режим (H.264)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
