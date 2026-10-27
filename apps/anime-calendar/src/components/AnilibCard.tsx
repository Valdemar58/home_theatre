"use client";
import { ArrowTopRightOnSquareIcon, ChevronDownIcon } from "@heroicons/react/20/solid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { LIST_LABELS } from "@/lib/labels";
import { relative } from "@/lib/time";
import type { LibAction, LibField, LibPlanItem, LibStatus, LibValues } from "@/lib/types";
import { Button, cx, ErrorBox, Skel, Spinner } from "./ui";
import { imgSrc } from "@/lib/img";

// Синхронизация с AniLib: подключение по ссылке на профиль, предпросмотр, запись, статус.
// Работа идёт на сервере — карточку можно закрыть; пока идёт, состояние опрашивается раз в секунду.

const STAGES: Record<string, string> = {
  fetch: "Загружаю закладки AniLib",
  match: "Сопоставляю тайтлы с AniList",
  apply: "Записываю в список",
};

const GROUPS: { action: LibAction; label: string; hint?: string; tone: string }[] = [
  { action: "add", label: "Добавится", tone: "text-green-300" },
  { action: "update", label: "Обновится", tone: "text-indigo-300" },
  { action: "conflict", label: "Конфликты", hint: "изменено и там, и тут — останется как в календаре", tone: "text-amber-300" },
  { action: "unmatched", label: "Не сопоставлено", hint: "укажите тайтл AniList вручную", tone: "text-red-300" },
  { action: "removed", label: "Удалено в календаре", hint: "не возвращаем", tone: "text-gray-400" },
  { action: "skipped", label: "Пропущено", hint: "папка AniLib без пары в календаре", tone: "text-gray-400" },
];

const FIELD_LABELS: Record<LibField, string> = { status: "статус", episodes: "серии", score: "оценка" };

const show = (f: LibField, v: LibValues | null) => {
  const x = v?.[f];
  if (x === null || x === undefined || x === 0) return "—";
  return f === "status" ? LIST_LABELS[x as keyof typeof LIST_LABELS] : String(x);
};

function useLibStatus() {
  return useQuery({
    queryKey: ["anilib"],
    queryFn: () => api<LibStatus>("/api/anilib"),
    refetchInterval: (q) => (q.state.data?.progress && !q.state.data.progress.finishedAt ? 1000 : false),
  });
}

export function AnilibCard() {
  const qc = useQueryClient();
  const { data: st, isLoading } = useLibStatus();
  const [profile, setProfile] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const p = st?.progress;
  const running = Boolean(p && !p.finishedAt);

  // Запись закончилась — обновить список
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ["list"] });
    wasRunning.current = running;
  }, [running, qc]);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["anilib"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const sync = (apply: boolean) => call(() => api("/api/anilib/sync", { method: "POST", json: { apply } }));

  // Заглушка по форме подключённого профиля: строка «Профиль … · синхронизировано» и кнопки
  if (isLoading || !st) return (
    <div className="flex flex-wrap items-center justify-between gap-3" aria-busy>
      <Skel className="h-4 w-72 max-w-full" />
      <div className="flex gap-2">{["w-40", "w-36", "w-24"].map((w) => <Skel key={w} className={cx("h-7 rounded-lg", w)} />)}</div>
    </div>
  );

  if (!st.linked) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-300">
          Вставьте ссылку на свой профиль AniLib — списки, прогресс и оценки подтянутся сюда и будут обновляться
          каждые 30 минут. Сначала покажем, что изменится. Если тайтл изменён и тут, и на AniLib — главнее календарь.
        </p>
        {error ? <ErrorBox error={error} /> : null}
        <form className="flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault();
          void call(() => api("/api/anilib", { method: "POST", json: { profile } }));
        }}>
          <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="https://v5.animelib.org/ru/user/…"
            className="min-w-64 flex-1 rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          <Button type="submit" variant="primary" disabled={!profile.trim() || busy}>{busy ? "Проверяю…" : "Подключить"}</Button>
        </form>
      </div>
    );
  }

  const plan = p?.plan;
  const firstRun = !st.syncedAt;
  const changes = plan ? plan.counts.add + plan.counts.update : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-gray-300">
          Профиль{" "}
          <a href={st.profileUrl!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-indigo-300 hover:text-indigo-200">
            {st.nickname} <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </a>
          {" · "}
          {st.syncedAt ? <>синхронизировано {Date.now() / 1000 - st.syncedAt < 60 ? "только что" : relative(st.syncedAt)}, дальше — каждые 30 мин</> : <span className="text-amber-300">ещё не импортировано</span>}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => sync(false)} disabled={running || busy}>Проверить изменения</Button>
          {!firstRun && <Button size="sm" onClick={() => sync(true)} disabled={running || busy}>Синхронизировать</Button>}
          <Button size="sm" variant="ghost" onClick={() => call(() => api("/api/anilib", { method: "DELETE" }))} disabled={running || busy}>Отключить</Button>
        </div>
      </div>

      {st.error && !running && <ErrorBox error={st.error} />}
      {error ? <ErrorBox error={error} /> : null}

      {running && p && (
        <div className="space-y-2 rounded-lg bg-gray-900/60 p-4 ring-1 ring-gray-700">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-gray-200"><Spinner className="h-4 w-4" />{STAGES[p.stage]}</span>
            <span className="tabular-nums text-gray-400">{p.stage === "fetch" ? p.done : `${p.done} / ${p.total}`}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
            <div className={cx("h-full rounded-full bg-indigo-500 transition-all", p.stage === "fetch" && "w-1/4 animate-pulse")}
              style={p.stage !== "fetch" ? { width: `${p.total ? (p.done / p.total) * 100 : 100}%` } : undefined} />
          </div>
          <p className="text-xs text-gray-500">Можно уйти со страницы — работа идёт на сервере.</p>
        </div>
      )}

      {p?.stage === "error" && <ErrorBox error={p.error} />}

      {!running && p?.stage === "done" && p.apply && plan && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-200">
          Готово: добавлено {plan.counts.add}, обновлено {plan.counts.update}
          {plan.counts.conflict ? `, конфликтов ${plan.counts.conflict} (оставлено как в календаре)` : ""}.
        </div>
      )}

      {!running && p?.stage === "done" && !p.apply && plan && (
        <Preview items={plan.items} counts={plan.counts} onMapped={() => sync(false)}
          action={
            changes > 0 ? (
              <Button variant="primary" onClick={() => sync(true)} disabled={busy}>
                {firstRun ? `Импортировать (${changes})` : `Применить (${changes})`}
              </Button>
            ) : firstRun ? (
              <Button variant="primary" onClick={() => sync(true)} disabled={busy}>Подтвердить и включить синхронизацию</Button>
            ) : <span className="text-sm text-gray-400">Всё уже совпадает</span>
          } />
      )}
    </div>
  );
}

function Preview({ items, counts, action, onMapped }: {
  items: LibPlanItem[];
  counts: Record<LibAction, number>;
  action: React.ReactNode;
  onMapped: () => void;
}) {
  const [open, setOpen] = useState<LibAction | null>(counts.unmatched ? "unmatched" : counts.add ? "add" : counts.update ? "update" : null);
  return (
    <div className="space-y-3 rounded-lg bg-gray-900/60 p-4 ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {GROUPS.filter((g) => counts[g.action]).map((g) => (
          <button key={g.action} onClick={() => setOpen(open === g.action ? null : g.action)}
            className={cx("inline-flex items-center gap-1 hover:underline", g.tone)}>
            {g.label}: <b>{counts[g.action]}</b>
            <ChevronDownIcon className={cx("h-4 w-4 transition", open === g.action && "rotate-180")} />
          </button>
        ))}
        <span className="text-gray-500">Без изменений: {counts.same}</span>
      </div>

      {open && (
        <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
          {GROUPS.find((g) => g.action === open)?.hint && (
            <p className="pb-1 text-xs text-gray-500">{GROUPS.find((g) => g.action === open)!.hint}</p>
          )}
          {items.filter((i) => i.action === open).map((i) => <Row key={i.libMediaId} item={i} onMapped={onMapped} />)}
        </div>
      )}
      <div className="flex justify-end">{action}</div>
    </div>
  );
}

function Row({ item, onMapped }: { item: LibPlanItem; onMapped: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fields = item.action === "conflict" ? item.conflicts : item.action === "update" ? item.fields : [];
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-gray-800/60">
      {item.cover
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={imgSrc(item.cover, "thumb")} alt="" className="h-10 w-7 shrink-0 rounded object-cover" loading="lazy" />
        : <div className="h-10 w-7 shrink-0 rounded bg-gray-800" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-gray-200">
          {item.anilistId ? <a href={`/anime/${item.anilistId}`} className="hover:text-indigo-300">{item.title}</a> : item.title}
          {item.how === "search" && <span className="ml-2 text-xs text-gray-500">найдено по названию</span>}
        </p>
        <p className="truncate text-xs text-gray-400">
          {item.action === "add" && <>{show("status", item.lib)}{item.lib.score ? ` · оценка ${item.lib.score}` : ""}{item.lib.episodes ? ` · серий ${item.lib.episodes}` : ""}</>}
          {fields.map((f) => (
            <span key={f} className="mr-3">
              {FIELD_LABELS[f]}: {item.action === "conflict"
                ? <>тут {show(f, item.local)}, на AniLib {show(f, item.lib)}</>
                : <>{show(f, item.local)} → <b className="text-gray-200">{show(f, item.lib)}</b></>}
            </span>
          ))}
          {item.action === "unmatched" && <>{item.original} · <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-gray-200">на AniLib</a>{" · "}
            <a href={`https://anilist.co/search/anime?search=${encodeURIComponent(item.original)}`} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200">найти на AniList</a></>}
          {(item.action === "removed" || item.action === "skipped") && item.folder}
        </p>
        {err && <p className="text-xs text-red-300">{err}</p>}
      </div>
      {item.action === "unmatched" && (
        <form className="flex shrink-0 gap-1.5" onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await api("/api/anilib/map", { method: "POST", json: { libMediaId: item.libMediaId, anilist: value } });
            onMapped();
          } catch (x) {
            setErr(x instanceof Error ? x.message : String(x));
          }
        }}>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="ссылка или id AniList"
            className="w-44 rounded-md border border-gray-600 bg-gray-900 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none" />
          <Button size="sm" type="submit" disabled={!value.trim()}>OK</Button>
        </form>
      )}
    </div>
  );
}
