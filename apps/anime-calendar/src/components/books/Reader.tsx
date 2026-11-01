"use client";
import { AdjustmentsHorizontalIcon, ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aiCref } from "@/lib/book-translate";
import { chapterName, pickTranslation, translationLabel, translationsOf, type ChapterContentView, type ChapterSummary, type Edition } from "@/lib/books";
import { api, useBook, useBookChapter, useBookProgress } from "@/lib/client";
import { Button, cx, ErrorBox, Skel, Spinner } from "../ui";
import { providerName, readHref } from "./BookView";
import { MangaReader, MangaSettingsPanel, useMangaSettings } from "./MangaReader";
import type { MangaAiPage } from "@/lib/manga-ocr";

// Ридер главы. Ранобэ — текст абзацами (шрифт, размер, ширина, интервал, тема — у браузера), позиция — по абзацу,
// дочитал до конца — глава отмечена в списке. Перевод главы — переключателем (команда, провайдер, оригинал),
// выбор запоминается у книги. Манга — `MangaReader` (страницы или лента).

type Theme = "dark" | "sepia" | "light";
type Settings = { size: number; width: number; leading: number; serif: boolean; theme: Theme };
const DEFAULTS: Settings = { size: 19, width: 44, leading: 1.75, serif: true, theme: "dark" };
const KEY = "reader-settings";
// Цвета страницы книги (не интерфейса): тёмная — как у календаря, сепия и светлая — для долгого чтения
const THEMES: Record<Theme, { bg: string; fg: string; dim: string }> = {
  dark: { bg: "#111827", fg: "#e5e7eb", dim: "#9ca3af" },
  sepia: { bg: "#f4ecd8", fg: "#3b2f20", dim: "#7a6a52" },
  light: { bg: "#ffffff", fg: "#1f2937", dim: "#6b7280" },
};

function useSettings(): [Settings, (s: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(DEFAULTS);
  useEffect(() => {
    try { setS({ ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) }); } catch { /* по умолчанию */ }
  }, []);
  const update = (x: Partial<Settings>) => setS((cur) => {
    const next = { ...cur, ...x };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* не страшно */ }
    return next;
  });
  return [s, update];
}

export function Reader({ id }: { id: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const edition = (params.get("e") ?? "main") as Edition;
  const key = params.get("c") ?? "";
  const provider = params.get("p");
  const cref = params.get("r");
  const { data: page } = useBook(id);
  const { data: progress } = useBookProgress(id);
  const { data: content, error, isLoading } = useBookChapter(id, provider, cref);
  const [settings, set] = useSettings();
  const [manga, setManga, mangaScope] = useMangaSettings(id, page?.book.kind);
  const [panel, setPanel] = useState(false);
  const [tools, setTools] = useState(true);
  const readerRoot = useRef<HTMLDivElement>(null);
  const theme = THEMES[settings.theme];
  const pages = content?.kind === "pages" ? content.pages : null;
  // Перевод страниц ИИ (TASKS 5.8): слой поверх картинок, пока идёт — опрос раз в 3 с
  const mangaAi = useQuery({
    queryKey: ["manga-ai", id, provider, cref], enabled: Boolean(pages && provider && cref),
    queryFn: () => api<MangaAiState>(`/api/books/${id}/manga-ai?provider=${encodeURIComponent(provider!)}&cref=${encodeURIComponent(cref!)}`),
    refetchInterval: (q) => (q.state.data?.task && ["queued", "running"].includes(q.state.data.task.status) && !q.state.data.pages ? 3000 : false),
  });
  const [aiOn, setAiOn] = useState(true);

  const ed = page?.editions.find((e) => e.edition === edition);
  const idx = ed ? ed.chapters.findIndex((c) => c.key === key) : -1;
  const chapter = idx >= 0 ? ed!.chapters[idx] : null;
  const translations = chapter ? translationsOf(chapter) : [];
  const current = translations.find((t) => t.provider === provider && t.cref === cref);
  const pref = useMemo(() => ({ languages: page?.preferredLanguages, ...(current ? { provider: current.provider, ref: current.ref, lang: current.lang, team: current.team } : progress?.pref ?? {}) }), [current, progress?.pref, page?.preferredLanguages]);
  const go = useCallback((i: number) => {
    const c = ed?.chapters[i];
    const t = c && pickTranslation(c, pref);
    if (c && t) router.push(readHref(id, edition, c, t));
  }, [ed, pref, router, id, edition]);
  const prev = idx > 0 ? () => go(idx - 1) : null;
  const next = ed && idx >= 0 && idx < ed.chapters.length - 1 ? () => go(idx + 1) : null;

  // Следующая глава — заранее
  useEffect(() => {
    const c = ed && idx >= 0 ? ed.chapters[idx + 1] : null;
    const t = c && pickTranslation(c, pref);
    if (t) void qc.prefetchQuery({ queryKey: ["book-chapter", id, t.provider, t.cref], staleTime: Infinity,
      queryFn: () => api(`/api/books/${id}/chapter?provider=${encodeURIComponent(t.provider)}&cref=${encodeURIComponent(t.cref)}`) });
  }, [ed, idx, pref, qc, id]);

  // Позиция: первый видимый абзац; раз в 5 с и при уходе. Конец главы виден — дочитано
  const pos = useRef(0);
  const done = useRef(false);
  const positionOwner = useRef<string | null>(null);
  const positionKey = `${id}:${edition}:${key}:${provider}:${cref}`;
  const reportPosition = (i: number) => {
    if (positionOwner.current !== positionKey) done.current = false;
    positionOwner.current = positionKey;
    pos.current = i;
  };
  const saved = progress?.positions.find((p) => p.edition === edition && p.chapter === key && p.provider === provider && p.cref === cref);
  const save = useCallback((final = false) => {
    if (!provider || !cref || !key || positionOwner.current !== positionKey) return;
    void fetch(`/api/books/${id}/progress`, {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: final,
      body: JSON.stringify({ chapter: key, edition, provider, cref, pos: pos.current, done: done.current, ordinal: idx >= 0 ? idx + 1 : null }),
    }).catch(() => undefined);
  }, [id, key, edition, provider, cref, idx, positionKey]);
  useEffect(() => {
    const t = setInterval(() => save(), 5000);
    const leave = () => save(true);
    window.addEventListener("pagehide", leave);
    return () => { clearInterval(t); window.removeEventListener("pagehide", leave); save(true); };
  }, [save]);
  // Выбор перевода — у книги
  useEffect(() => {
    if (current && (progress?.pref.provider !== current.provider || progress?.pref.team !== current.team || progress?.pref.ref !== current.ref)) {
      void api(`/api/books/${id}/progress`, { method: "POST", json: { pref: { provider: current.provider, ref: current.ref, lang: current.lang, team: current.team, edition } } });
    }
  }, [current, progress?.pref, id, edition]);

  // Клавиши ← → — главы (у манги — свои, в MangaReader)
  useEffect(() => {
    if (pages) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === "ArrowLeft" && prev) prev();
      if (e.key === "ArrowRight" && next) next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, pages]);

  const finish = () => { if (!done.current) { done.current = true; save(); void qc.invalidateQueries({ queryKey: ["book-progress", id] }); } };
  const title = chapter ? `${chapterName(chapter, edition)}${chapter.title ? ` · ${chapter.title}` : ""}` : "Глава";
  const bookName = page ? page.book.title.ru || page.book.title.romaji || "" : "";

  return (
    <div ref={readerRoot} className="-mx-4 -mt-6 min-h-screen overflow-y-auto lg:-mx-8" style={{ background: theme.bg, color: theme.fg }}>
      {/* Шапка ридера */}
      <div className={cx("sticky top-16 z-10 flex items-center gap-2 border-b px-3 py-2 backdrop-blur", !tools && "hidden")} style={{ background: `${theme.bg}e6`, borderColor: `${theme.dim}40` }}>
        <Link href={`/manga/${id}`} className="flex min-w-0 items-center gap-1.5 text-sm" style={{ color: theme.dim }} title="К книге">
          <ArrowLeftIcon className="h-4 w-4 shrink-0" /><span className="hidden truncate sm:inline">{bookName}</span>
        </Link>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-medium">{title}</span>
        {translations.length > 1 && (
          <select value={`${provider}|${cref}`} onChange={(e) => {
            const [p, r] = e.target.value.split("|");
            if (chapter) router.replace(readHref(id, edition, chapter, { provider: p, cref: r }));
          }} className="max-w-[14rem] rounded-md border bg-transparent px-2 py-1 text-xs" style={{ borderColor: `${theme.dim}60` }} title="Перевод главы">
            {translations.map((t) => <option key={`${t.provider}|${t.cref}`} value={`${t.provider}|${t.cref}`} style={{ color: "#111" }}>{translationLabel(t, providerName)}</option>)}
          </select>
        )}
        <button onClick={() => setPanel(!panel)} className="rounded p-1.5" style={{ color: theme.dim }} title={pages ? "Вид страниц" : "Вид текста"}><AdjustmentsHorizontalIcon className="h-5 w-5" /></button>
        <button className="rounded p-1.5 text-xs" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void readerRoot.current?.requestFullscreen(); }} title="Полный экран">⛶</button>
        {pages && <button className="rounded p-1.5 text-xs" onClick={async () => {
          const refreshed = await api<ChapterContentView>(`/api/books/${id}/chapter?provider=${encodeURIComponent(provider!)}&cref=${encodeURIComponent(cref!)}&refresh=1`);
          qc.setQueryData(["book-chapter", id, provider, cref], refreshed);
        }} title="Обновить истёкшие ссылки на страницы">Обновить страницы</button>}
      </div>
      {!tools && <button onClick={() => setTools(true)} className="fixed right-4 top-20 z-20 rounded-lg bg-gray-900/90 px-3 py-2 text-xs text-white">Панели</button>}
      {panel && (pages ? <MangaSettingsPanel s={manga} set={setManga} scope={mangaScope} /> : <SettingsPanel s={settings} set={set} />)}

      {pages && provider && cref && (current?.lang !== "ru" || mangaAi.data?.pages) && (
        <MangaAiBar bookId={id} provider={provider} cref={cref} data={mangaAi.data} on={aiOn} setOn={setAiOn} dim={theme.dim}
          refresh={() => void qc.invalidateQueries({ queryKey: ["manga-ai", id, provider, cref] })} />
      )}
      {pages && progress && <MangaReader key={`${provider}:${cref}`} pages={pages} ai={aiOn ? mangaAi.data?.pages : null} s={manga} restore={saved && !saved.done ? saved.pos : 0} prev={prev} next={next} dim={theme.dim} onToggleControls={() => { setTools((v) => !v); setPanel(false); }}
        onPos={reportPosition} onEnd={finish} />}
      {pages && <ChapterNav prev={prev} next={next} id={id} />}

      {!pages && <article className="mx-auto px-4 pb-10 pt-6" style={{ maxWidth: `${settings.width}rem`, fontSize: settings.size, lineHeight: settings.leading,
        fontFamily: settings.serif ? "Georgia, 'PT Serif', 'Times New Roman', serif" : "inherit" }}>
        <h1 className="mb-6 text-center font-bold" style={{ fontSize: "1.25em" }}>{title}</h1>
        {chapter && (!chapter.langs.ru || provider === "ai") && (chapter.langs.orig || chapter.langs.en) && page?.book.kind === "novel" && (
          <AiBar bookId={id} edition={edition} chapter={chapter} current={provider} ahead={progress?.pref.aiAhead ?? 0} dim={theme.dim}
            onReady={() => { void qc.invalidateQueries({ queryKey: ["book", id] }).then(() => router.replace(readHref(id, edition, chapter, { provider: "ai", cref: aiCref(edition, chapter.key) }))); }} />
        )}
        {isLoading && <div className="space-y-3"><Skel className="h-4 w-full" /><Skel className="h-4 w-11/12" /><Skel className="h-4 w-10/12" /></div>}
        {error ? <ErrorBox error={error} /> : null}
        {content && <Body content={content} restore={saved && !saved.done ? saved.pos : 0} onPos={reportPosition}
          onEnd={finish} dim={theme.dim} />}
        <ChapterNav prev={prev} next={next} id={id} />
      </article>}
    </div>
  );
}

/**
 * Перевод ИИ (TASKS 5.7): у главы без русского — «Перевести ИИ» (и вперёд на N глав, запоминается у книги);
 * пока переводится — состояние раз в 3 с, готово — открыть перевод. Читаешь перевод ИИ — пометка об этом.
 */
function AiBar({ bookId, edition, chapter, current, ahead, dim, onReady }: {
  bookId: number; edition: Edition; chapter: ChapterSummary; current: string | null; ahead: number; dim: string; onReady: () => void;
}) {
  const qc = useQueryClient();
  const [n, setN] = useState(ahead);
  useEffect(() => setN(ahead), [ahead]);
  const key = ["book-ai", bookId, edition, chapter.key];
  const { data } = useQuery({
    queryKey: key, queryFn: () => api<{ done: boolean; task: { status: string; error: string | null } | null }>(`/api/books/${bookId}/translate?edition=${edition}&key=${encodeURIComponent(chapter.key)}`),
    refetchInterval: (q) => (q.state.data?.task && ["queued", "running"].includes(q.state.data.task.status) ? 3000 : false),
  });
  const busy = data?.task && ["queued", "running"].includes(data.task.status);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !busy && data?.done && current !== "ai") onReady();
    was.current = Boolean(busy);
  }, [busy, data?.done, current, onReady]);
  const start = async () => {
    await api(`/api/books/${bookId}/translate`, { method: "POST", json: { edition, key: chapter.key, ahead: n } });
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ["book-progress", bookId] });
  };
  const box = "mb-6 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm";
  const style = { borderColor: `${dim}50`, color: dim, fontFamily: "system-ui, sans-serif" };
  if (current === "ai") return <div className={box} style={style}>Перевод ИИ по глоссарию франшизы — имена и термины можно поправить в глоссарии книги.</div>;
  return (
    <div className={box} style={style}>
      <span className="mr-auto">{data?.done ? "Есть перевод ИИ этой главы." : "Русского перевода этой главы нет."}</span>
      {data?.done ? <Button size="sm" variant="primary" onClick={onReady}>Читать перевод ИИ</Button> : busy ? (
        <span className="flex items-center gap-2"><Spinner className="h-4 w-4" />{data!.task!.status === "queued" ? "В очереди на перевод…" : "Перевожу…"}</span>
      ) : (
        <>
          <label className="flex items-center gap-1.5">и вперёд на
            <select value={n} onChange={(e) => setN(Number(e.target.value))} className="rounded border bg-transparent px-1 py-0.5" style={{ borderColor: `${dim}60` }}>
              {[0, 3, 5, 10].map((x) => <option key={x} value={x} style={{ color: "#111" }}>{x}</option>)}
            </select> гл.
          </label>
          <Button size="sm" variant="primary" onClick={() => void start()}>Перевести ИИ</Button>
        </>
      )}
      {data?.task?.status === "error" && <span className="w-full text-xs text-negative-300">Не вышло: {data.task.error}</span>}
    </div>
  );
}

type MangaAiState = { pages: MangaAiPage[] | null; model: string | null; task: { status: string; error: string | null } | null };

/** Перевод страниц манги ИИ: запуск, состояние, «оригинал / перевод». */
function MangaAiBar({ bookId, provider, cref, data, on, setOn, dim, refresh }: {
  bookId: number; provider: string; cref: string; data: MangaAiState | undefined; on: boolean; setOn: (x: boolean) => void; dim: string; refresh: () => void;
}) {
  const busy = data?.task && ["queued", "running"].includes(data.task.status) && !data.pages;
  const btn = (active: boolean) => cx("rounded px-2 py-0.5", active && "tone-accent solid");
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-2 px-3 py-2 text-xs" style={{ color: dim }}>
      {data?.pages ? (
        <>
          <span>Перевод ИИ{data.model ? ` (${data.model})` : ""}:</span>
          <button className={btn(!on)} onClick={() => setOn(false)}>Оригинал</button>
          <button className={btn(on)} onClick={() => setOn(true)}>Перевод</button>
        </>
      ) : busy ? (
        <span className="flex items-center gap-2"><Spinner className="h-3.5 w-3.5" />{data!.task!.status === "queued" ? "В очереди на перевод страниц…" : "Читаю текст на страницах и перевожу…"}</span>
      ) : (
        <>
          <span>Русского перевода нет — можно перевести страницы ИИ</span>
          <Button size="sm" onClick={() => void api(`/api/books/${bookId}/manga-ai`, { method: "POST", json: { provider, cref } }).then(refresh)}>Перевести ИИ</Button>
        </>
      )}
      {data?.task?.status === "error" && !data.pages && <span className="w-full text-center text-negative-300">Не вышло: {data.task.error}</span>}
    </div>
  );
}

/** Навигация в конце главы. */
function ChapterNav({ prev, next, id }: { prev: (() => void) | null; next: (() => void) | null; id: number }) {
  return (
    <div className="mx-auto mt-10 flex max-w-3xl items-center justify-between gap-3 px-4 pb-10 text-base" style={{ fontFamily: "inherit" }}>
      {prev ? <Button onClick={prev}><ChevronLeftIcon className="h-4 w-4" />Предыдущая</Button> : <span />}
      {next ? <Button variant="primary" onClick={next}>Следующая<ChevronRightIcon className="h-4 w-4" /></Button>
        : <Link href={`/manga/${id}`}><Button>К книге</Button></Link>}
    </div>
  );
}

/** Текст главы; позиция — индекс первого видимого блока. */
function Body({ content, restore, onPos, onEnd, dim }: { content: ChapterContentView; restore: number; onPos: (i: number) => void; onEnd: () => void; dim: string }) {
  const root = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Вернуться к месту, где остановились
    if (restore > 0) el.querySelector<HTMLElement>(`[data-i="${Math.floor(restore)}"]`)?.scrollIntoView({ block: "start" });
    const seen = new Set<number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (e.isIntersecting) seen.add(i); else seen.delete(i);
      }
      if (seen.size) onPos(Math.min(...seen));
    }, { rootMargin: "-80px 0px -40% 0px" });
    el.querySelectorAll("[data-i]").forEach((n) => io.observe(n));
    const fin = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) onEnd(); });
    if (end.current) fin.observe(end.current);
    return () => { io.disconnect(); fin.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  if (content.kind === "external") {
    return <p style={{ color: dim }}>Глава у официального издателя: <a href={content.url} target="_blank" rel="noreferrer" className="underline">открыть</a></p>;
  }
  return (
    <div ref={root}>
      {content.kind === "text" ? content.blocks.map((b, i) =>
        b.t === "p" ? <p key={i} data-i={i} className="mb-[0.9em] indent-[1.5em]">{b.text}</p>
          : b.t === "img" ? <img key={i} data-i={i} src={b.url} alt="" loading="lazy" className="mx-auto my-6 max-h-[80vh] rounded" />
          : <hr key={i} data-i={i} className="my-8 opacity-30" />,
      ) : null}
      {content.kind === "text" && !content.blocks.length && <p style={{ color: dim }}>В главе нет текста.</p>}
      <div ref={end} className="h-1" />
    </div>
  );
}

function SettingsPanel({ s, set }: { s: Settings; set: (x: Partial<Settings>) => void }) {
  const row = "flex items-center justify-between gap-3";
  const btn = (on: boolean) => cx("rounded-md px-2.5 py-1 text-sm ring-1", on ? "tone-accent solid ring-transparent" : "ring-gray-500/40");
  return (
    <div className="sticky top-[7.25rem] z-10 mx-auto mt-2 w-[min(24rem,calc(100%-2rem))] space-y-3 rounded-xl bg-gray-900/95 p-4 text-sm text-gray-100 shadow-2xl ring-1 ring-gray-700">
      <div className={row}><span>Размер</span><span className="flex items-center gap-2">
        <button className={btn(false)} onClick={() => set({ size: Math.max(14, s.size - 1) })}>A−</button>
        <span className="w-8 text-center tabular-nums">{s.size}</span>
        <button className={btn(false)} onClick={() => set({ size: Math.min(30, s.size + 1) })}>A+</button></span></div>
      <div className={row}><span>Ширина</span><span className="flex gap-1">{[[36, "Узко"], [44, "Средне"], [60, "Широко"]].map(([w, l]) =>
        <button key={w} className={btn(s.width === w)} onClick={() => set({ width: w as number })}>{l}</button>)}</span></div>
      <div className={row}><span>Интервал</span><span className="flex gap-1">{[1.5, 1.75, 2].map((v) =>
        <button key={v} className={btn(s.leading === v)} onClick={() => set({ leading: v })}>{String(v).replace(".", ",")}</button>)}</span></div>
      <div className={row}><span>Шрифт</span><span className="flex gap-1">
        <button className={btn(s.serif)} onClick={() => set({ serif: true })} style={{ fontFamily: "Georgia, serif" }}>С засечками</button>
        <button className={btn(!s.serif)} onClick={() => set({ serif: false })}>Без засечек</button></span></div>
      <div className={row}><span>Тема</span><span className="flex gap-1">{(["dark", "sepia", "light"] as Theme[]).map((t) =>
        <button key={t} className={btn(s.theme === t)} onClick={() => set({ theme: t })}>{t === "dark" ? "Тёмная" : t === "sepia" ? "Сепия" : "Светлая"}</button>)}</span></div>
    </div>
  );
}

export const ReaderLoading = () => <div className="grid place-items-center py-20"><Spinner className="h-8 w-8" /></div>;
