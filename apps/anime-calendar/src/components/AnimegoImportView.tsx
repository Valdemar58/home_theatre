"use client";
import { ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon } from "@heroicons/react/20/solid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { LIST_LABELS } from "@/lib/labels";
import { LIST_STATUSES, type AgItem, type AgReview, type ListStatus, type MediaLite } from "@/lib/types";
import { useConfirm } from "./Dialogs";
import { Badge, Button, Chip, cx, EmptyState, ErrorBox, Skel, Spinner } from "./ui";

// Проверка разового импорта AnimeGo: что и как запишется в список. Правка любой строки сохраняется сразу
// (файлом рядом с планом), запись в список — только кнопкой внизу.

type Filter = "all" | "add" | "update" | "check" | "none" | "skip" | "edited";

const FILTERS: { id: Filter; label: string; test: (i: AgItem) => boolean }[] = [
  { id: "all", label: "Все", test: () => true },
  { id: "add", label: "Добавятся", test: (i) => i.include && !i.local },
  { id: "update", label: "Обновятся", test: (i) => i.include && Boolean(i.local) },
  { id: "check", label: "Проверить", test: (i) => i.how === "check" || i.duplicate },
  { id: "none", label: "Не сопоставлено", test: (i) => !i.anilistId },
  { id: "skip", label: "Не переносятся", test: (i) => !i.include },
  { id: "edited", label: "Изменённые", test: (i) => i.edited },
];

const HOW: Record<AgItem["how"], { label: string; tone: "neutral" | "warning" | "info" | "negative" } | null> = {
  list: { label: "уже в списке", tone: "neutral" },
  search: null,
  check: { label: "найдено неточно", tone: "warning" },
  manual: { label: "выбрано вручную", tone: "info" },
  none: { label: "не найдено", tone: "negative" },
};

const show = (status: ListStatus | null, score: number | null) =>
  `${status ? LIST_LABELS[status] : "—"}${score ? ` · ${score}` : ""}`;

const SELECT = "rounded-md border border-gray-600 bg-gray-900 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none disabled:opacity-50";

export function AnimegoImportView() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, error, isLoading } = useQuery({
    queryKey: ["import-animego"],
    queryFn: () => api<AgReview>("/api/import/animego"),
    refetchInterval: (q) => (q.state.data?.progress && !q.state.data.progress.finishedAt ? 1000 : false),
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<unknown>(null);

  const edit = async (agId: number, patch: Record<string, unknown>) => {
    setErr(null);
    // Сразу на экране, потом — с сервера (у новой привязки — карточка тайтла и состояние в списке)
    qc.setQueryData<AgReview>(["import-animego"], (d) => d && {
      ...d, items: d.items.map((i) => i.agId !== agId ? i : {
        ...i, edited: true,
        ...("status" in patch ? { status: patch.status as ListStatus } : {}),
        ...("score" in patch ? { score: patch.score as number | null } : {}),
        ...("skip" in patch ? { include: !patch.skip } : {}),
      }),
    });
    try {
      await api("/api/import/animego", { method: "POST", json: { agId, ...patch } });
    } catch (e) {
      setErr(e);
    }
    await qc.invalidateQueries({ queryKey: ["import-animego"] });
  };

  const items = data?.items ?? [];
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, items.filter(f.test).length])) as Record<Filter, number>, [items]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = FILTERS.find((x) => x.id === filter)!;
    return items.filter((i) => f.test(i) && (!t || [i.title, i.original, i.media?.title, i.media?.romaji].some((s) => s?.toLowerCase().includes(t))));
  }, [items, filter, q]);

  const p = data?.progress;
  const running = Boolean(p && !p.finishedAt);
  const apply = async () => {
    const ok = await confirm({
      title: `Записать ${counts.add + counts.update} тайтлов в список?`,
      text: <>Добавится {counts.add}, обновится {counts.update}. Изменения уйдут и в Shikimori — по очереди, за несколько минут.</>,
      confirm: "Записать",
    });
    if (!ok) return;
    try {
      await api("/api/import/animego", { method: "POST", json: { apply: true } });
    } catch (e) {
      setErr(e);
    }
    await qc.invalidateQueries({ queryKey: ["import-animego"] });
  };

  if (isLoading) return (
    <div className="mx-auto max-w-6xl space-y-3" aria-busy>
      <Skel className="h-8 w-64" />
      <p className="flex items-center gap-2 text-sm text-gray-400"><Spinner className="h-4 w-4" />Загружаю карточки тайтлов с AniList — в первый раз до минуты</p>
      {Array.from({ length: 8 }, (_, k) => <Skel key={k} className="h-16 w-full" />)}
    </div>
  );
  if (error) return <ErrorBox error={error} />;
  if (!data?.profile) return (
    <EmptyState title="Плана импорта нет">Сначала запусти <code>python scripts/import_animego.py &lt;id профиля&gt;</code>.</EmptyState>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Импорт AnimeGo</h1>
        <p className="text-sm text-gray-400">
          Профиль <a href={`https://animego.me/user/${data.profile}`} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200">{data.profile}</a>
          {" · "}{items.length} записей. По умолчанию новые тайтлы добавляются со статусом и оценкой AnimeGo, у тех, что уже
          в списке, ставится только оценка, если её нет. Правки сохраняются сразу, в список ничего не пишется до кнопки внизу.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} · {counts[f.id]}</Chip>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию"
          className="ml-auto w-56 rounded-md border border-gray-600 bg-gray-900 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" />
      </div>

      {err ? <ErrorBox error={err} /> : null}

      <div className="divide-y divide-gray-800 rounded-lg bg-gray-900/60 ring-1 ring-gray-700">
        {shown.map((i) => <Row key={i.agId} item={i} disabled={running} onEdit={(patch) => edit(i.agId, patch)} />)}
        {!shown.length && <p className="px-4 py-6 text-center text-sm text-gray-500">Ничего не нашлось</p>}
      </div>

      <div className="sticky bottom-16 z-20 rounded-lg bg-gray-900/95 px-4 py-3 ring-1 ring-gray-700 backdrop-blur md:bottom-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          {running && p ? (
            <span className="flex items-center gap-2 text-gray-200"><Spinner className="h-4 w-4" />Записываю {p.done} / {p.total}</span>
          ) : p?.finishedAt ? (
            <span className={p.error || p.failed.length ? "text-warning-300" : "text-positive-300"}>
              {p.error ? `Ошибка: ${p.error}` : `Записано ${p.done - p.failed.length} из ${p.total}`}
              {p.failed.length ? ` · не записались: ${p.failed.join(", ")}` : ""}
            </span>
          ) : (
            <span className="text-gray-300">
              Запишется <b>{counts.add + counts.update}</b>: добавится {counts.add}, обновится {counts.update} · не переносится {counts.skip}
            </span>
          )}
          <Button variant="primary" onClick={apply} disabled={running || !(counts.add + counts.update)}>Записать в список</Button>
        </div>
      </div>
    </div>
  );
}

function Row({ item: i, disabled, onEdit }: { item: AgItem; disabled: boolean; onEdit: (patch: Record<string, unknown>) => void }) {
  const [picking, setPicking] = useState(false);
  const how = HOW[i.how];
  return (
    <div className="px-3 py-2.5">
      <div className={cx("grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)_auto]", !i.include && !picking && "opacity-60")}>
        <input type="checkbox" checked={i.include} disabled={disabled || !i.anilistId} title="Переносить"
          onChange={(e) => onEdit({ skip: !e.target.checked })} className="h-4 w-4 accent-indigo-500" />

        {/* AnimeGo */}
        <div className="min-w-0">
          <p className="truncate text-sm text-gray-200" title={i.title}>{i.title}</p>
          <p className="truncate text-xs text-gray-500" title={i.original ?? ""}>{i.original}</p>
          <p className="text-xs text-gray-400">AnimeGo: {show(i.ag.status, i.ag.score)}</p>
        </div>

        {/* Тайтл календаря */}
        <div className="col-start-2 flex min-w-0 items-center gap-2.5 md:col-start-auto">
          {i.media?.cover
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={imgSrc(i.media.cover, "thumb")} alt="" className="h-12 w-8 shrink-0 rounded object-cover" loading="lazy" />
            : <div className="h-12 w-8 shrink-0 rounded bg-gray-800" />}
          <div className="min-w-0 flex-1">
            {i.media ? (
              <a href={`/anime/${i.media.id}`} target="_blank" rel="noreferrer" className="block truncate text-sm text-gray-100 hover:text-indigo-300" title={i.media.romaji ?? ""}>
                {i.media.title}
              </a>
            ) : <p className="text-sm text-gray-500">{i.anilistId ? `AniList ${i.anilistId}` : "Не привязано"}</p>}
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-gray-400">
              {i.media && <span>{[i.media.format, i.media.year, i.media.episodes && `${i.media.episodes} эп.`].filter(Boolean).join(" · ")}</span>}
              {how && <Badge tone={how.tone} className="h-5 px-2 text-[11px]">{how.label}</Badge>}
              {i.duplicate && <Badge tone="warning" className="h-5 px-2 text-[11px]">привязан к двум записям</Badge>}
              <button onClick={() => setPicking(!picking)} disabled={disabled} className="text-indigo-300 hover:text-indigo-200">
                {i.anilistId ? "сменить" : "выбрать тайтл"}
              </button>
            </p>
            <p className="text-xs text-gray-500">{i.local ? `В календаре: ${show(i.local.status, i.local.score)}` : i.anilistId ? "Нет в списке" : ""}</p>
          </div>
        </div>

        {/* Что запишется */}
        <div className="col-start-2 flex items-center gap-2 md:col-start-auto">
          <select value={i.status ?? ""} disabled={disabled || !i.anilistId} onChange={(e) => onEdit({ status: e.target.value })} className={SELECT}>
            {!i.status && <option value="">—</option>}
            {LIST_STATUSES.map((s) => <option key={s} value={s}>{LIST_LABELS[s]}</option>)}
          </select>
          <select value={i.score ?? ""} disabled={disabled || !i.anilistId} title="Оценка"
            onChange={(e) => onEdit({ score: e.target.value ? Number(e.target.value) : null })} className={cx(SELECT, "w-16")}>
            <option value="">—</option>
            {Array.from({ length: 10 }, (_, k) => 10 - k).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={() => onEdit({ reset: true })} disabled={disabled || !i.edited} title="Вернуть как было"
            className={cx("rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white", !i.edited && "invisible")}>
            <ArrowUturnLeftIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {picking && <Picker item={i} onPick={(anilistId) => { setPicking(false); onEdit({ anilistId }); }} />}
    </div>
  );
}

/** Выбор тайтла: поиск каталога (русские названия — через Shikimori) или ссылка/id AniList. */
function Picker({ item, onPick }: { item: AgItem; onPick: (anilistId: number | null) => void }) {
  const [q, setQ] = useState(item.original ?? item.title);
  const [found, setFound] = useState<MediaLite[] | null>(null);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2 || /^(?:.*anime\/)?\d+\/?.*$/.test(t)) { setFound(null); return; }
    const timer = setTimeout(() => {
      void api<{ media: MediaLite[] }>(`/api/search?q=${encodeURIComponent(t)}`).then((r) => setFound(r.media)).catch(() => setFound([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [q]);
  const byId = Number(q.trim().match(/^(?:.*anime\/)?(\d+)/)?.[1]);
  return (
    <div className="mt-2 space-y-2 rounded-md bg-gray-800/60 p-3 md:ml-7">
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Название, ссылка или id AniList"
          className="min-w-0 w-full flex-1 sm:min-w-64 rounded-md border border-gray-600 bg-gray-900 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" />
        {byId > 0 && <Button size="sm" variant="primary" onClick={() => onPick(byId)}>Привязать AniList {byId}</Button>}
        <a href={`https://anilist.co/search/anime?search=${encodeURIComponent(item.original ?? item.title)}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200">искать на AniList <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" /></a>
        {item.anilistId && <Button size="sm" variant="ghost" onClick={() => onPick(null)}>Отвязать</Button>}
      </div>
      {found === null && q.trim().length >= 2 && !byId && <p className="flex items-center gap-2 text-xs text-gray-400"><Spinner className="h-3.5 w-3.5" />Ищу…</p>}
      {found?.length === 0 && <p className="text-xs text-gray-500">Ничего не нашлось — попробуй другое название или вставь ссылку с AniList</p>}
      <div className="grid gap-1 sm:grid-cols-2">
        {found?.map((m) => (
          <button key={m.id} onClick={() => onPick(m.id)}
            className={cx("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-700/60", m.id === item.anilistId && "ring-1 ring-indigo-500")}>
            {m.coverImage.large
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={imgSrc(m.coverImage.large, "thumb")} alt="" className="h-10 w-7 shrink-0 rounded object-cover" />
              : <div className="h-10 w-7 shrink-0 rounded bg-gray-800" />}
            <span className="min-w-0">
              <span className="block truncate text-sm text-gray-100">{m.title.ru || m.title.romaji}</span>
              <span className="block truncate text-xs text-gray-400">{[m.format, m.seasonYear ?? m.startDate.year, m.episodes && `${m.episodes} эп.`].filter(Boolean).join(" · ")} · {m.title.romaji}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
