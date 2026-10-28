"use client";
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { api } from "@/lib/client";
import type { PlayInfo } from "@/lib/player";
import type { AnimeDetails } from "@/lib/types";
import { Button, cx, Spinner } from "../ui";
import { VoicesButton } from "../VoicesButton";
import type { PlayerControls, SubSettings } from "./Player";

// Боковая панель плеера (как у AniLib): вкладки «Озвучка / Субтитры». Озвучка — дорожки файла и другие раздачи
// с русской озвучкой (окно «Озвучки»: «Смотреть» другую раздачу). Субтитры — дорожки файла, японские с Jimaku
// (найти, если их нет), сдвиг по времени и размер текста.

export function WatchSidebar({ media, info, sub, subs: settings, controls }: {
  media: AnimeDetails; info: PlayInfo | null; sub: number | null; subs: SubSettings;
  controls: React.MutableRefObject<PlayerControls | null>;
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
            {info.extVoices.length > 0 && (
              <div className="space-y-1 border-t border-gray-700 px-2 pt-3">
                <p className="text-xs text-gray-400">В раздаче есть озвучки отдельными файлами:</p>
                <p className="text-sm text-gray-200">{info.extVoices.join(", ")}</p>
                <p className="text-xs text-gray-500">Онлайн их не сыграть — Jellyfin не подмешивает звук к потоку. «Скачать» в «Озвучках» соберёт их в серии дорожками.</p>
              </div>
            )}
            <div className="space-y-1.5 border-t border-gray-700 px-2 pt-3">
              <p className="text-xs text-gray-500">
                Другая озвучка — другая раздача: найдите её в «Озвучках» и нажмите «Смотреть» (серии «Стрима» заменятся) или
                «Скачать» (в библиотеку, озвучки отдельными файлами станут дорожками).
              </p>
              <VoicesButton media={media} size="sm" />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Row active={sub === null} onClick={() => controls.current?.setSub(null)}>Выключены</Row>
              {subs.map((s) => (
                <Row key={s.index} active={s.index === sub} onClick={() => controls.current?.setSub(s.index)}>
                  {s.label}{s.signs && !s.label.includes("надписи") ? <span className="text-gray-500"> · надписи</span> : null}
                  {s.torrent ? <span className="text-gray-500"> · из раздачи</span> : s.external && !s.jimaku ? <span className="text-gray-500"> · файл рядом</span> : null}
                </Row>
              ))}
              {!subs.length && <p className="px-2 pt-1 text-xs text-gray-500">В файле нет субтитров.</p>}
            </div>
            {!subs.some((s) => s.jimaku) && <JimakuFind anilistId={media.id} onFound={() => controls.current?.reload()} />}
            <SubSettingsPanel settings={settings} controls={controls} ass={Boolean(subs.find((s) => s.index === sub)?.ass)} />
          </div>
        )}
      </div>
    </aside>
  );
}

/** Японские субтитры с Jimaku (для слабослышащих): скачать для всего тайтла, плеер подхватит дорожку. */
function JimakuFind({ anilistId, onFound }: { anilistId: number; onFound: () => void }) {
  const [state, setState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const find = async () => {
    setState({ busy: true, note: null });
    try {
      const r = await api<{ files: number; note: string | null }>(`/api/anime/${anilistId}/subs/jimaku`, { method: "POST" });
      setState({ busy: false, note: r.files ? `Найдено файлов: ${r.files}` : r.note ?? "Ничего не нашлось" });
      if (r.files) onFound();
    } catch (e) {
      setState({ busy: false, note: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="space-y-1.5 border-t border-gray-700 px-2 pt-3">
      <p className="text-xs text-gray-500">Японские субтитры для слабослышащих — с Jimaku. Тайминг бывает от другого релиза: поправьте сдвигом ниже.</p>
      <Button size="sm" onClick={find} disabled={state.busy}>
        {state.busy ? <><Spinner className="h-3.5 w-3.5" /> Ищу на Jimaku…</> : "Найти японские на Jimaku"}
      </Button>
      {state.note && <p className="text-xs text-gray-400">{state.note}</p>}
    </div>
  );
}

/** Сдвиг по времени (для всех субтитров тайтла) и размер текста (только текстовые: ASS рисуется стилями файла). */
function SubSettingsPanel({ settings, controls, ass }: { settings: SubSettings; controls: React.MutableRefObject<PlayerControls | null>; ass: boolean }) {
  const d = settings.delay;
  return (
    <div className="space-y-2 border-t border-gray-700 px-2 pt-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-gray-300">Сдвиг</span>
        <Step onClick={() => controls.current?.setSubDelay(d - 0.5)} label="Раньше на 0,5 с"><MinusIcon className="h-3.5 w-3.5" /></Step>
        <button onClick={() => controls.current?.setSubDelay(0)} title="Сбросить" className="w-16 text-center tabular-nums text-gray-200">
          {d > 0 ? "+" : ""}{d.toFixed(1).replace(".", ",")} с
        </button>
        <Step onClick={() => controls.current?.setSubDelay(d + 0.5)} label="Позже на 0,5 с"><PlusIcon className="h-3.5 w-3.5" /></Step>
      </div>
      <div className={cx("flex items-center gap-2", ass && "opacity-50")} title={ass ? "ASS рисуется стилями из файла — размер не меняется" : undefined}>
        <span className="flex-1 text-gray-300">Размер</span>
        <input type="range" min={60} max={200} step={10} value={settings.size} disabled={ass}
          onChange={(e) => controls.current?.setSubSize(Number(e.target.value))} className="w-28 accent-accent-400" aria-label="Размер субтитров" />
        <span className="w-10 text-right tabular-nums text-gray-400">{settings.size}%</span>
      </div>
    </div>
  );
}

function Step({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return <button onClick={onClick} title={label} aria-label={label} className="grid h-7 w-7 place-items-center rounded-md bg-gray-700/60 text-gray-200 hover:bg-gray-600">{children}</button>;
}

function Row({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("block w-full rounded-md px-2 py-1.5 text-left text-sm transition",
      active ? "bg-accent-500/15 font-medium text-accent-200" : "text-gray-200 hover:bg-gray-700/60")}>
      {children}
    </button>
  );
}
