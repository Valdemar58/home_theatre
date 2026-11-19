"use client";
import { ArrowTopRightOnSquareIcon, ExclamationTriangleIcon, PlayCircleIcon, TrashIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/client";
import { relative } from "@/lib/time";
import type { QueueItem } from "@/server/downloads";
import type { PrebufferProgress } from "@/server/prebuffer";
import type { StreamItem } from "@/server/stream";
import { useHoverCard } from "./HoverCard";
import { Img } from "./Img";
import { Button, cx, EmptyState, ErrorBox, Skel } from "./ui";
import { useAlert, useConfirm } from "./Dialogs";

// «Загрузки»: что смотрится онлайн (TorrServer) и что качается (Sonarr → qBittorrent).
// Обновляется раз в 3 с, пока страница открыта.

type Downloads = {
  streams: StreamItem[]; streamsError: string | null; queue: QueueItem[]; queueError: string | null;
  prebuffer: PrebufferProgress[]; prebufferQueued: string[];
  prep?: { count: number; downloading: number; used: number; limit: number };
};

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
const speed = (b: number) => (b > 0 ? `${(b / 1e6).toFixed(1)} МБ/с` : null);
const eta = (s: number) => (s < 90 ? `${Math.ceil(s)} с` : s < 5400 ? `${Math.round(s / 60)} мин` : `${(s / 3600).toFixed(1)} ч`);

/** Хватает ли скорости активной раздачи для просмотра без остановок. */
function SpeedVerdict({ s }: { s: StreamItem }) {
  if (!s.rate || s.speed <= 0) return null;
  const ok = s.speed >= s.rate * 1.2;
  return (
    <p className={cx("text-xs", ok ? "text-green-300" : "text-amber-300")}>
      Для просмотра нужно ~{(s.rate / 1e6).toFixed(1)} МБ/с, сейчас {(s.speed / 1e6).toFixed(1)} МБ/с —{" "}
      {ok ? "скорости хватает" : "будут остановки: подготовьте серию заранее"}
    </p>
  );
}

/** Серии раздачи: «Подготовить» → прогресс, когда можно включать, отмена. */
function Episodes({ s, data, onChange }: { s: StreamItem; data: Downloads; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const alert = useAlert();
  const prepOf = (index: number) => data.prebuffer.find((p) => p.hash === s.hash && p.index === index);
  const queued = (index: number) => data.prebufferQueued.includes(`${s.hash}:${index}`);
  const busy = s.files.filter((f) => prepOf(f.index) || queued(f.index));
  const shown = open ? s.files : busy;
  const call = async (index: number, method: "POST" | "DELETE") => {
    await api("/api/downloads/prebuffer", { method, json: { hash: s.hash, index } }).catch((e) => alert({ title: "Не получилось", text: e instanceof Error ? e.message : String(e) }));
    onChange();
  };
  if (!s.files.length) return null;
  return (
    <div className="space-y-1.5 pt-1">
      <button onClick={() => setOpen(!open)} className="text-xs text-indigo-300 hover:text-indigo-200">
        {open ? "Скрыть серии" : `Серии (${s.files.length}) — подготовить к просмотру без остановок`}
      </button>
      {shown.map((f) => {
        const p = prepOf(f.index);
        const q = queued(f.index);
        return (
          <div key={f.index} className="flex items-center gap-3 rounded-lg bg-gray-900/50 px-3 py-1.5 text-xs">
            <span className="w-16 shrink-0 font-mono text-gray-300">{f.code}</span>
            {p ? (
              <div className="min-w-0 flex-1 space-y-1">
                <Bar value={p.read / p.size} tone={p.ready ? "green" : "indigo"} />
                <p className="flex flex-wrap gap-x-3 text-gray-400">
                  <span>{Math.round((p.read / p.size) * 100)}% · {size(p.read)} из {size(p.size)}</span>
                  {p.speed > 0 && !p.done && <span>{speed(p.speed)} (сглаженная)</span>}
                  {p.ready
                    ? <span className="font-medium text-green-300">{p.done ? "Целиком в кэше" : "Можно включать — досмотрите без остановок"}</span>
                    : p.etaSec !== null
                      ? <span className="text-amber-200">Можно будет через ~{eta(p.etaSec)}</span>
                      : <span className="text-amber-300">Скорости нет — прогноз невозможен</span>}
                </p>
              </div>
            ) : (
              <span className="flex-1 text-gray-500">{q ? "В очереди…" : ""}</span>
            )}
            {p || q
              ? !p?.done && <button onClick={() => call(f.index, "DELETE")} className="text-gray-400 hover:text-white">Отменить</button>
              : <button onClick={() => call(f.index, "POST")} className="text-indigo-300 hover:text-indigo-200">Подготовить</button>}
          </div>
        );
      })}
    </div>
  );
}

function Bar({ value, tone = "indigo" }: { value: number; tone?: "indigo" | "amber" | "green" }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
      <div className={cx("h-full rounded-full transition-all", tone === "amber" ? "bg-amber-500" : tone === "green" ? "bg-green-500" : "bg-indigo-500")}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

function Thumb({ src, id }: { src: string | null; id: number | null }) {
  const hover = useHoverCard(id ?? 0);
  const img = (
    <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-gray-700">
      {src && <Img src={src} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
    </div>
  );
  return id ? <Link href={`/anime/${id}`} {...hover} className="shrink-0 transition hover:brightness-110">{img}</Link> : img;
}

/** Название — ссылка на страницу тайтла (если тайтл опознан). */
function TitleLink({ id, className, title, children }: { id: number | null; className: string; title?: string; children: React.ReactNode }) {
  const hover = useHoverCard(id ?? 0);
  return id
    ? <Link href={`/anime/${id}`} {...hover} className={cx(className, "hover:text-indigo-300")} title={title}>{children}</Link>
    : <p className={className} title={title}>{children}</p>;
}

function JellyfinLink({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <Button size="sm"><ArrowTopRightOnSquareIcon className="h-4 w-4" /> В Jellyfin</Button>
    </a>
  );
}

/** Счётчик у заголовка раздела; пока грузится — заглушка той же высоты. */
function Count({ n }: { n: number | undefined }) {
  return n === undefined
    ? <span className="inline-flex align-middle"><Skel className="h-4 w-5" /></span>
    : <span className="text-base font-normal text-gray-500">{n}</span>;
}

/** Строка раздачи/загрузки, пока список не пришёл: обложка, название, кнопки, подписи. */
function RowSkeleton() {
  return (
    <div aria-busy className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <Skel className="h-20 w-14 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-start gap-3"><Skel className="h-5 flex-1" /><Skel className="h-7 w-24 rounded-lg" /></div>
        <Skel className="h-3 w-64 max-w-full" />
        <Skel className="h-3 w-40" />
      </div>
    </div>
  );
}

export function DownloadsView() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["downloads"],
    queryFn: () => api<Downloads>("/api/downloads"),
    refetchInterval: 3000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const alert = useAlert();
  const act = async (key: string, ask: { title: string; text: string; confirm: string }, path: string) => {
    if (!(await confirm({ ...ask, danger: true }))) return;
    setBusy(key);
    try {
      await api(path, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["downloads"] });
    } catch (e) {
      alert({ title: "Не получилось", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (error || (!isLoading && !data)) return <ErrorBox error={error} />;
  const problems = data?.queue.filter((q) => q.problem) ?? [];

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-bold sm:text-3xl">Загрузки</h1>

      <section className="space-y-3">
        <div>
          <h2 className="text-xl font-bold">Онлайн-просмотр <Count n={data?.streams.length} /></h2>
          <p className="text-sm text-gray-400">
            Кнопка «Смотреть»: раздача в TorrServer, серии — в библиотеке Jellyfin «Стрим». Целиком она не качается —
            TorrServer тянет куски под то, что сейчас смотрится. «Подготовить» серию — она скачается целиком
            (qBittorrent) и будет играть с диска; придёт уведомление. Скачанное удаляется само: через 3 дня после
            просмотра, через 14 дней без просмотра или когда места больше лимита. «Убрать» — удалить раздачу и ссылки из Jellyfin.
          </p>
          {data?.prep && (data.prep.count > 0 || data.prep.downloading > 0) && (
            <p className="mt-1 text-sm text-gray-300">
              Скачано серий: {data.prep.count}{data.prep.downloading ? `, качается: ${data.prep.downloading}` : ""} ·{" "}
              {(data.prep.used / 2 ** 30).toFixed(1).replace(".", ",")} из {Math.round(data.prep.limit / 2 ** 30)} ГБ
            </p>
          )}
        </div>
        {!data ? <RowSkeleton /> : data.streamsError && <ErrorBox error={`TorrServer недоступен: ${data.streamsError}`} />}
        {!data ? null : data.streams.length === 0 && !data.streamsError ? (
          <EmptyState title="Ничего не смотрится онлайн">Нажмите «Смотреть» в окне «Озвучки» на странице тайтла.</EmptyState>
        ) : data.streams.map((s) => (
          <div key={s.hash} className="flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
            <Thumb src={s.poster} id={s.anilistId} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 basis-full sm:basis-0 flex-1"><TitleLink id={s.anilistId} className="block truncate font-semibold" title={s.title}>{s.title}</TitleLink></div>
                <JellyfinLink url={s.jellyfinUrl} />
                <Button size="sm" variant="ghost" disabled={busy === s.hash}
                  onClick={() => act(s.hash, { title: `Убрать «${s.title}» из онлайн-просмотра?`, text: "Серии пропадут из библиотеки «Стрим» в Jellyfin.", confirm: "Убрать" }, `/api/downloads/streams/${s.hash}`)}>
                  <TrashIcon className="h-4 w-4" /> Убрать
                </Button>
              </div>
              <p className="flex flex-wrap gap-x-3 text-xs text-gray-400">
                <span className="text-gray-200">{s.state}</span>
                <span>{size(s.size)}</span>
                {s.cached > 0 && <span>в кэше {size(s.cached)}</span>}
                {speed(s.speed) && <span>{speed(s.speed)}</span>}
                <span>пиры {s.peers}{s.seeders ? ` (сиды ${s.seeders})` : ""}</span>
                {s.addedAt && <span>добавлена {relative(s.addedAt)}</span>}
              </p>
              <SpeedVerdict s={s} />
              <p className="flex items-center gap-1.5 text-xs text-gray-400">
                <PlayCircleIcon className="h-4 w-4" />
                {s.folder ? <>В Jellyfin: {s.folder} · серий {s.episodes}</> : <span className="text-amber-300/90">ссылок в Jellyfin нет — раздачу можно убрать</span>}
              </p>
              <Episodes s={s} data={data} onChange={() => void qc.invalidateQueries({ queryKey: ["downloads"] })} />
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h2 className="text-xl font-bold">Скачивание <Count n={data?.queue.length} /></h2>
            <p className="text-sm text-gray-400">Очередь Sonarr → qBittorrent. Скачанное попадает в библиотеку «Аниме».</p>
          </div>
        </div>
        {!data ? <RowSkeleton /> : data.queueError && <ErrorBox error={`Sonarr недоступен: ${data.queueError}`} />}
        {problems.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-500/30">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" />
            С проблемой: {problems.length} из {data?.queue.length}. Причина показана у каждой загрузки.
          </div>
        )}
        {!data ? null : data.queue.length === 0 && !data.queueError ? (
          <EmptyState title="Ничего не качается">Нажмите «Скачать» в окне «Озвучки» или «Запросить» на странице тайтла.</EmptyState>
        ) : data.queue.map((q) => {
          const p = q.size ? q.done / q.size : 0;
          return (
            <div key={q.id} className={cx("flex gap-4 rounded-xl bg-gray-800/50 p-3 ring-1", q.problem ? "ring-amber-500/40" : "ring-gray-700")}>
              <Thumb src={q.poster} id={q.anilistId} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <TitleLink id={q.anilistId} className="block truncate font-semibold">{q.series ?? q.title}{q.episode && <span className="ml-2 text-sm font-normal text-gray-400">{q.episode}</span>}</TitleLink>
                    <p className="truncate text-xs text-gray-500" title={q.title}>{q.title}</p>
                  </div>
                  <JellyfinLink url={q.jellyfinUrl} />
                  <Button size="sm" variant="ghost" disabled={busy === `q${q.id}`}
                    onClick={() => act(`q${q.id}`, { title: `Отменить загрузку «${q.title}»?`, text: "Скачанное будет удалено.", confirm: "Отменить загрузку" }, `/api/downloads/queue/${q.id}`)}>
                    <TrashIcon className="h-4 w-4" /> Отменить
                  </Button>
                </div>
                <Bar value={p} tone={q.problem ? "amber" : p >= 1 ? "green" : "indigo"} />
                <p className="flex flex-wrap gap-x-3 text-xs text-gray-400">
                  <span className="text-gray-200">{q.state}</span>
                  <span>{Math.round(p * 100)}% · {size(q.done)} из {size(q.size)}</span>
                  {q.timeleft && !q.problem && <span>осталось {q.timeleft}</span>}
                  {q.addedAt && <span>добавлена {relative(q.addedAt)}</span>}
                </p>
                {q.problem && <p className="text-xs text-amber-300">{q.problem}</p>}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
