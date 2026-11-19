"use client";
import { EyeIcon, EyeSlashIcon, HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { useList, useListMutation } from "@/lib/client";
import type { MediaLite } from "@/lib/types";
import { RatingStars } from "./RatingStars";
import { cx } from "./ui";

// Готовые личные теги: из них рекомендации понимают, ЗА ЧТО понравилось
export const SUGGESTED_TAGS = [
  "так плохо, что смешно", "озвучка решает", "шедевр", "пересмотрю", "guilty pleasure",
  "ради атмосферы", "ради сюжета", "ради персонажей", "ради боёвки", "смешно", "до слёз",
  "отключить мозг", "затянуто", "не зашло", "скучно", "раздражает",
];

const VOICES = ["AniLibria", "AniLiberty", "Dream Cast", "StudioBand", "AniDUB", "AniStar", "SHIZA", "JAM", "AnimeVost", "DEEP", "Crunchyroll", "Субтитры", "Оригинал"];

/** Мои впечатления: оценка, личные теги, озвучка, заметка. Сохраняется сразу. */
export function Impressions({ media }: { media: MediaLite }) {
  const { byId } = useList();
  const { upsert } = useListMutation();
  const entry = byId.get(media.id);
  const [note, setNote] = useState(entry?.note ?? "");
  const [custom, setCustom] = useState("");
  useEffect(() => setNote(entry?.note ?? ""), [entry?.note]);

  const save = (patch: Parameters<typeof upsert.mutate>[0]["patch"]) => upsert.mutate({ media, patch });
  const tags = entry?.tags ?? [];
  const toggleTag = (t: string) => save({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const score = entry?.score ?? 0;

  return (
    <section className="rounded-xl bg-gray-800/50 p-5 ring-1 ring-gray-700">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold">Мои впечатления</h2>
        <span className="text-xs text-gray-500">Учитываются в рекомендациях: не только «понравилось», но и за что</span>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-24 text-sm text-gray-400">Оценка</span>
          {/* Повторный клик по выбранной звезде снимает оценку; без записи в списке — сразу «Просмотрено» */}
          <RatingStars value={score} onChange={(n) => save({ score: n, ...(entry ? {} : { status: "completed" }) })} />
          <span className="text-sm font-semibold tabular-nums text-gray-300">{score || "—"}</span>
        </div>

        {/* Явная рекомендация другим: да / нет / не выбрано (повторный клик снимает) */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-24 text-sm text-gray-400">Советую?</span>
          <div className="flex flex-wrap gap-1.5">
            {([[true, "Рекомендую", HandThumbUpIcon, "border-green-500 bg-green-600/20 text-green-200"],
              [false, "Не рекомендую", HandThumbDownIcon, "border-red-500 bg-red-600/20 text-red-200"]] as const).map(([value, label, Icon, on]) => (
              <button key={label}
                onClick={() => save({ recommend: entry?.recommend === value ? null : value, ...(entry ? {} : { status: "completed" }) })}
                className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition",
                  entry?.recommend === value ? on : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200")}>
                <Icon className="h-4 w-4" />{label}
              </button>
            ))}
          </div>
        </div>

        {/* Скрытый тайтл не виден друзьям ни в профиле, ни в общих оценках */}
        {entry && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-24 text-sm text-gray-400">Друзьям</span>
            <button onClick={() => save({ private: !entry.private })}
              className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition",
                entry.private ? "border-amber-500 bg-amber-600/20 text-amber-200" : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200")}>
              {entry.private ? <><EyeSlashIcon className="h-4 w-4" />Скрыто от друзей</> : <><EyeIcon className="h-4 w-4" />Видно друзьям</>}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-start gap-3">
          <span className="w-24 pt-1 text-sm text-gray-400">Теги</span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {[...new Set([...SUGGESTED_TAGS, ...tags])].map((t) => (
              <button key={t} onClick={() => toggleTag(t)}
                className={cx("rounded-full border px-2.5 py-0.5 text-xs transition",
                  tags.includes(t) ? "border-indigo-500 bg-indigo-600 text-white" : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200")}>
                {t}
              </button>
            ))}
            <form onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { toggleTag(custom.trim().toLowerCase()); setCustom(""); } }}>
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="свой тег…"
                className="w-28 rounded-full border border-gray-700 bg-transparent px-2.5 py-0.5 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none" />
            </form>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="w-24 text-sm text-gray-400">Озвучка</span>
          <input list="voices" defaultValue={entry?.voice ?? ""} key={entry?.voice ?? ""} placeholder="с какой озвучкой смотрел"
            onBlur={(e) => e.target.value !== (entry?.voice ?? "") && save({ voice: e.target.value || null })}
            className="w-full min-w-0 sm:w-64 rounded-md border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" />
          <datalist id="voices">{VOICES.map((v) => <option key={v} value={v} />)}</datalist>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <span className="w-24 pt-1.5 text-sm text-gray-400">Заметка</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            onBlur={() => note !== (entry?.note ?? "") && save({ note: note || null })}
            placeholder="Что зацепило или раздражало — пиши как есть, рекомендации это учтут"
            className="min-w-0 w-full flex-1 sm:min-w-64 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
        </div>
      </div>
    </section>
  );
}
