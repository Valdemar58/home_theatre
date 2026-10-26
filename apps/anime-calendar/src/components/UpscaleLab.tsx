"use client";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, useAnime, useAnimeImages } from "@/lib/client";
import { imgSrc } from "@/lib/img";
import { displayTitle } from "@/lib/schedule";
import type { MediaLite } from "@/lib/types";
import { UpscaleViewer, type ViewerItem } from "./UpscaleViewer";
import { Button, cx, ErrorBox, Spinner } from "./ui";

// Лаборатория ИИ-апскейла (для админа): найти тайтл → выбрать постер или кадр → посмотреть,
// как его улучшил прод (модель, масштаб), прогнать другие модели и масштабы и сравнить
// любые два варианта на весь экран (шторка / рядом / A-B, общий зум).

type UpRow = { key: string; url: string; state: string; model: string | null; scale: number | null; src_w: number | null; out_w: number | null; ms: number | null; error: string | null; target: number | null };
type Stats = {
  health: { ok: boolean; device: string | null };
  byState: { state: string; n: number; ms: number | null }[];
  recent: UpRow[];
  bytes: number;
  queue: number;
  config: { model: string; target: number; maxScale: number; minSrc: number };
  models: Record<string, number[]>;
};
type Run = { id: string; model: string; scale: number; ms: number; outWidth: number; bytes: number };

const STATE_RU: Record<string, string> = { done: "Готово", queued: "В очереди", running: "Идёт", failed: "Ошибка", skipped: "Не нужно", new: "Ожидает" };
const mb = (b: number) => `${(b / 1e6).toFixed(1)} МБ`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
const combo = (m: string, s: number) => `${m} ×${s}`;

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Плитка варианта: картинка + подпись; клик — открыть сравнение. */
function Tile({ src, title, note, active, onClick }: { src: string; title: string; note?: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx("group space-y-1 text-left", active && "opacity-100")}>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700 transition group-hover:ring-amber-400">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
      </div>
      <p className="text-xs font-medium text-gray-200">{title}</p>
      {note && <p className="text-[11px] text-gray-500">{note}</p>}
    </button>
  );
}

export function UpscaleLab() {
  const { data: stats, error, refetch } = useQuery({ queryKey: ["upscale-lab"], queryFn: () => api<Stats>("/api/upscale/lab"), refetchInterval: 5000 });
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 350);
  const { data: found, isFetching: searching } = useQuery({
    queryKey: ["suggest", dq],
    queryFn: () => api<{ media: MediaLite[] }>(`/api/search?q=${encodeURIComponent(dq)}`),
    enabled: dq.length >= 2,
  });
  const [titleId, setTitleId] = useState<number | null>(null);
  const { data: anime } = useAnime(titleId ?? 0);
  const { data: gallery } = useAnimeImages(titleId ?? 0);
  const [url, setUrl] = useState<string | null>(null);
  const { data: info } = useQuery({
    queryKey: ["upscale-info", url],
    queryFn: () => api<{ srcWidth: number; upscale: UpRow | null }>(`/api/upscale/lab?info=${encodeURIComponent(url!)}`),
    enabled: Boolean(url),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [viewer, setViewer] = useState<[string, string] | null>(null);

  // Выбрали тайтл — сразу его постер
  useEffect(() => {
    if (anime && titleId === anime.id) setUrl((u) => u ?? anime.coverXL ?? anime.coverImage.large);
  }, [anime, titleId]);
  // Набор моделей по умолчанию: прод-модель с масштабами + «резкая» ×4
  useEffect(() => {
    if (!stats || picked.size) return;
    setPicked(new Set([...stats.models[stats.config.model].map((s) => combo(stats.config.model, s)), combo("realesrgan-x4plus-anime", 4)]));
  }, [stats, picked.size]);

  if (error) return <ErrorBox error={error} />;
  if (!stats) return <Spinner />;

  const urlRuns = (url && runs[url]) || [];
  const prod = info?.upscale?.state === "done" ? info.upscale : null;
  const choose = (u: string) => { setUrl(u); setRunError(null); };
  const runAll = async () => {
    if (!url) return;
    setRunError(null);
    for (const c of [...picked]) {
      const [model, s] = c.split(" ×");
      if (urlRuns.some((r) => combo(r.model, r.scale) === c)) continue;
      setRunning(c);
      try {
        const r = await api<Omit<Run, "model" | "scale">>("/api/upscale/lab", { method: "POST", json: { url, model, scale: Number(s) } });
        setRuns((all) => ({ ...all, [url]: [...(all[url] ?? []), { ...r, model, scale: Number(s) }] }));
      } catch (e) {
        setRunError(e);
        break;
      }
    }
    setRunning(null);
    void refetch();
  };

  const items: ViewerItem[] = url ? [
    { id: "orig", label: "Оригинал", src: imgSrc(url, "full"), width: info?.srcWidth ?? 0, note: info ? `${info.srcWidth}px` : undefined },
    ...(prod ? [{ id: "prod", label: `Прод: ${combo(prod.model!, prod.scale!)}`, src: imgSrc(url, "full", true), width: prod.out_w ?? 0, note: `${prod.out_w}px` }] : []),
    ...urlRuns.map((r) => ({ id: r.id, label: combo(r.model, r.scale), src: `/api/upscale/lab?id=${r.id}`, width: r.outWidth, note: `${r.outWidth}px · ${sec(r.ms)}` })),
  ] : [];
  const open = (id: string) => setViewer(["orig", id === "orig" ? (items[1]?.id ?? "orig") : id]);
  const images = [
    ...(anime ? [{ url: anime.coverXL ?? anime.coverImage.large!, label: "Постер" }] : []),
    ...(gallery?.images ?? []).slice(0, 12).map((g) => ({ url: g.url, label: g.kind === "screenshot" ? "Кадр" : g.kind === "backdrop" ? "Фон" : "Баннер", thumb: g.thumb })),
  ];

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Лаборатория ИИ-апскейла</h1>
        <p className="mt-1 text-sm text-gray-400">
          Апскейл нужен только там, где исходника не хватает: карточкам — 480px (обложкам AniList в 460px — не нужен),
          крупно (шапка тайтла, весь экран) — {stats.config.target}px. Масштаб — наименьший из поддерживаемых моделью, что
          достаёт до цели (не больше ×{stats.config.maxScale}); меньше {stats.config.minSrc}px не трогаем. Настройки по умолчанию — .env (IMG_UPSCALE_*).
        </p>
      </div>

      <section className="grid gap-x-6 gap-y-2 rounded-xl bg-gray-800/50 p-4 text-sm ring-1 ring-gray-700 sm:grid-cols-2">
        <p>Апскейлер: {stats.health.ok
          ? <span className="text-green-300">работает · {stats.health.device}</span>
          : <span className="text-amber-300">недоступен — картинки показываются без апскейла</span>}</p>
        <p>Прод-модель: <b>{stats.config.model}</b></p>
        <p>Очередь: {stats.queue} · на диске: {mb(stats.bytes)}</p>
        <p className="flex flex-wrap gap-x-3">
          {stats.byState.map((b) => <span key={b.state}>{STATE_RU[b.state] ?? b.state}: {b.n}{b.ms ? ` (≈${sec(b.ms)})` : ""}</span>)}
        </p>
      </section>

      {/* 1. Тайтл и картинка */}
      <section className="space-y-3 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700">
        <h2 className="text-lg font-semibold">1. Картинка</h2>
        <label className="relative block max-w-xl">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название тайтла (можно по-русски)"
            className="h-10 w-full rounded-lg border border-gray-600 bg-gray-800 pl-10 pr-3 text-sm focus:border-indigo-500 focus:outline-none" />
          {searching && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
        </label>
        {dq.length >= 2 && found && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {found.media.slice(0, 10).map((m) => (
              <button key={m.id} onClick={() => { setTitleId(m.id); setUrl(null); }} title={displayTitle(m.title)}
                className={cx("w-20 shrink-0 space-y-1 text-left", titleId === m.id && "opacity-100")}>
                <div className={cx("aspect-[2/3] overflow-hidden rounded ring-2", titleId === m.id ? "ring-amber-400" : "ring-transparent hover:ring-gray-500")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imgSrc(m.coverImage.large ?? "", "thumb")} alt="" className="h-full w-full object-cover" />
                </div>
                <p className="line-clamp-2 text-[11px] leading-tight text-gray-300">{displayTitle(m.title)}</p>
              </button>
            ))}
          </div>
        )}
        {anime && (
          <div className="space-y-2">
            <p className="text-sm text-gray-300">{displayTitle(anime.title)} — что улучшать:</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {images.map((im) => (
                <button key={im.url} onClick={() => choose(im.url)}
                  className={cx("shrink-0 space-y-1 text-left")}>
                  <div className={cx("h-24 overflow-hidden rounded ring-2", url === im.url ? "ring-amber-400" : "ring-transparent hover:ring-gray-500")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imgSrc("thumb" in im && im.thumb ? im.thumb : im.url, "thumb")} alt="" className="h-full w-auto" />
                  </div>
                  <p className="text-[11px] text-gray-400">{im.label}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 2. Прогон и сравнение */}
      {url && (
        <section className="space-y-4 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700">
          <h2 className="text-lg font-semibold">2. Варианты и сравнение</h2>
          <p className="text-sm text-gray-300">
            Исходник: {info ? `${info.srcWidth}px` : "…"} ·{" "}
            {prod
              ? <>в проде улучшено <b>{combo(prod.model!, prod.scale!)}</b>: {prod.src_w}→{prod.out_w}px за {sec(prod.ms ?? 0)} (цель {prod.target}px)</>
              : info?.upscale
                ? <>в проде: {STATE_RU[info.upscale.state] ?? info.upscale.state}{info.upscale.error ? ` — ${info.upscale.error}` : ""}</>
                : "в проде не улучшалась (исходника хватает или ещё не показывалась крупно)"}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {Object.entries(stats.models).flatMap(([m, scales]) => scales.map((s) => {
              const c = combo(m, s);
              const done = urlRuns.some((r) => combo(r.model, r.scale) === c);
              return (
                <label key={c} className={cx("flex items-center gap-1.5", done && "text-gray-500")}>
                  <input type="checkbox" checked={picked.has(c)} className="accent-amber-400"
                    onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(c); else n.delete(c); return n; })} />
                  {c}{done && " ✓"}
                </label>
              );
            }))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!picked.size || Boolean(running) || !stats.health.ok} onClick={runAll}>
              {running ? <><Spinner className="h-4 w-4 text-white" /> {running}…</> : "Прогнать выбранные"}
            </Button>
            {items.length > 1 && <Button onClick={() => open(items[items.length - 1].id)}>Сравнить на весь экран</Button>}
          </div>
          {runError ? <ErrorBox error={runError} /> : null}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            {items.map((it) => (
              <Tile key={it.id} src={it.src} title={it.label} note={it.note} onClick={() => open(it.id)} />
            ))}
          </div>
          <p className="text-xs text-gray-500">Клик по плитке — сравнение с оригиналом на весь экран; там можно выбрать любые два варианта.</p>
        </section>
      )}

      {stats.recent.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Недавно улучшены в проде</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-8">
            {stats.recent.map((r) => (
              <Tile key={r.key} src={imgSrc(r.url, "card", true)} title={combo(r.model ?? "?", r.scale ?? 0)}
                note={`${r.src_w}→${r.out_w}px · ${sec(r.ms ?? 0)}`} onClick={() => { setTitleId(null); choose(r.url); }} />
            ))}
          </div>
        </section>
      )}

      {viewer && items.length > 0 && <UpscaleViewer items={items} initial={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}
