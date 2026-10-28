"use client";
import { useState } from "react";
import type { PlayInfo } from "@/lib/player";
import type { AnimeDetails } from "@/lib/types";
import { cx } from "../ui";
import { VoicesButton } from "../VoicesButton";
import type { PlayerControls } from "./Player";

// Боковая панель плеера (как у AniLib): вкладки «Озвучка / Субтитры». Озвучка — дорожки файла и другие раздачи
// с русской озвучкой (окно «Озвучки»: «Смотреть» другую раздачу), субтитры — дорожки файла.

export function WatchSidebar({ media, info, sub, controls }: {
  media: AnimeDetails; info: PlayInfo | null; sub: number | null; controls: React.MutableRefObject<PlayerControls | null>;
}) {
  const [tab, setTab] = useState<"audio" | "sub">("audio");
  const audio = info?.audio ?? [];
  const subs = info?.subs ?? [];
  return (
    <aside className="flex max-h-[min(36rem,70vh)] flex-col overflow-hidden rounded-xl bg-gray-800/40 ring-1 ring-gray-700">
      <div className="flex border-b border-gray-700">
        {([["audio", "Озвучка", audio.length], ["sub", "Субтитры", subs.length]] as const).map(([k, l, n]) => (
          <button key={k} onClick={() => setTab(k)}
            className={cx("flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition", tab === k ? "border-accent-400 text-white" : "border-transparent text-gray-400 hover:text-gray-200")}>
            {l} <span className="text-xs text-gray-500">{n}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!info ? (
          <p className="p-2 text-sm text-gray-500">Готовлю поток…</p>
        ) : tab === "audio" ? (
          <div className="space-y-3">
            <div>
              <p className="px-2 pb-1 text-xs text-gray-500">В этом файле</p>
              {audio.map((t) => (
                <Row key={t.index} active={t.index === info.audioIndex} onClick={() => controls.current?.setAudio(t.index)}>{t.label}</Row>
              ))}
              {audio.length === 1 && <p className="px-2 pt-1 text-xs text-gray-500">Других дорожек в файле нет.</p>}
            </div>
            <div className="space-y-1.5 border-t border-gray-700 px-2 pt-3">
              <p className="text-xs text-gray-500">Другая озвучка — другая раздача: выберите её и нажмите «Смотреть», серии «Стрима» заменятся.</p>
              <VoicesButton media={media} size="sm" />
            </div>
          </div>
        ) : (
          <div>
            <Row active={sub === null} onClick={() => controls.current?.setSub(null)}>Выключены</Row>
            {subs.map((s) => (
              <Row key={s.index} active={s.index === sub} onClick={() => controls.current?.setSub(s.index)}>
                {s.label}{s.signs ? <span className="text-gray-500"> · надписи</span> : null}{s.external ? <span className="text-gray-500"> · файл рядом</span> : null}
              </Row>
            ))}
            {!subs.length && <p className="px-2 pt-1 text-xs text-gray-500">В файле нет субтитров.</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

function Row({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("block w-full rounded-md px-2 py-1.5 text-left text-sm transition",
      active ? "bg-accent-500/15 font-medium text-accent-200" : "text-gray-200 hover:bg-gray-700/60")}>
      {children}
    </button>
  );
}
