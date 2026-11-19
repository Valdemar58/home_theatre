"use client";
import { useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, LockClosedIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { GroupPlan, GroupSession } from "@/lib/groups";
import { episodeAvailability, episodeCount, episodeLabel, legacyBlocks, localDateTime, localTimeCandidates, makeBlock, sessionTimeline, type SessionBlock } from "@/lib/session-plan";
import { displayTitle } from "@/lib/schedule";
import type { SharedListDetail } from "@/lib/types";
import { Button, cx } from "./ui";
import { Img } from "./Img";

const field = "min-w-0 rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent-300";
export function SessionEditor({ plan, list, session, onDone, act }: { plan: GroupPlan; list: SharedListDetail; session?: GroupSession; onDone: () => void; act: (body: Record<string, unknown>) => Promise<boolean> }) {
  const initialZone = session?.plan?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [zone, setZone] = useState(initialZone);
  const [at, setAt] = useState(() => localDateTime(session?.startsAt ?? Math.ceil((Date.now() / 1000 + 3600) / 60) * 60, initialZone));
  const [fold, setFold] = useState<number | null>(null);
  const candidates = useMemo(() => localTimeCandidates(at, zone), [at, zone]);
  const startsAt = candidates.length === 1 ? candidates[0] : candidates.includes(fold ?? -1) ? fold! : candidates.includes(session?.startsAt ?? -1) ? session!.startsAt : NaN;
  const [blocks, setBlocks] = useState<SessionBlock[]>(() => session ? structuredClone(session.plan?.blocks ?? legacyBlocks(session)) : []);
  const [skip, setSkip] = useState(session?.plan?.skipCredits ?? false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [page, setPage] = useState<Record<number, number>>({});
  const drag = useRef<{ id: number; anchor: number; selected: Set<number>; selecting: boolean; available: Set<number> } | null>(null);
  const mouseHandled = useRef(false);
  const media = new Map(list.items.map(i => [i.media.id, i.media]));
  const title = (id: number) => media.has(id) ? displayTitle(media.get(id)!.title) : `Тайтл #${id}`;
  const timeline = sessionTimeline(blocks, startsAt, skip);
  const fmt = (t: number) => Number.isFinite(t) ? new Intl.DateTimeFormat("ru-RU", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(t * 1000) : "—";
  const patch = (id: number, fields: Partial<SessionBlock>) => setBlocks(bs => bs.map(b => b.anilistId === id ? { ...b, ...fields } : b));
  const invalid = blocks.some(b => !b.episodes.length || !media.has(b.anilistId) || b.episodes.some(ep => !episodeAvailability(media.get(b.anilistId)!, ep, startsAt).selectable) || !Number.isInteger(b.breakMinutes) || b.breakMinutes < 0 || b.breakMinutes > 240);
  const stale = session && plan.sessions.find(s => s.id === session.id)?.revision !== session.revision;
  const canSave = blocks.length > 0 && !invalid && Number.isFinite(startsAt) && startsAt > Date.now() / 1000 && !stale;
  const options = list.items.filter(i => !blocks.some(b => b.anilistId === i.media.id) && (i.planningState !== "proposed" || plan.capabilities.queue) && title(i.media.id).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const move = (i: number, delta: number) => setBlocks(bs => { const next = [...bs]; [next[i], next[i + delta]] = [next[i + delta], next[i]]; return next; });
  const range = (ep: number) => {
    const d = drag.current; if (!d) return;
    const next = new Set(d.selected);
    for (let n = Math.min(d.anchor, ep); n <= Math.max(d.anchor, ep); n++) if (d.available.has(n)) { if (d.selecting) next.add(n); else next.delete(n); }
    patch(d.id, { episodes: [...next].sort((a, b) => a - b) });
  };
  return <form className="space-y-6 py-3" aria-label={session ? "Редактирование сеанса" : "Новый сеанс"} onSubmit={async e => {
    e.preventDefault(); if (!canSave || saving) return; setSaving(true); setSaveFailed(false);
    try { if (await act({ action: "session-save", sessionId: session?.id, revision: session?.revision, startsAt, plan: { blocks, skipCredits: skip, timeZone: zone } })) onDone(); else setSaveFailed(true); }
    finally { setSaving(false); }
  }}>
    <fieldset disabled={saving} className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex min-w-0 flex-col gap-1.5 text-sm">Начало сеанса<input className={field} type="datetime-local" required value={at} onChange={e => { setAt(e.target.value); setFold(null); }} /></label>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm">Часовой пояс<select className={field} value={zone} onChange={e => { setZone(e.target.value); setFold(null); }}>
        {[...new Set([initialZone, "UTC", ...Intl.supportedValuesOf("timeZone")])].map(z => <option key={z}>{z}</option>)}
      </select></label>
      <div className="min-w-0 text-sm" aria-live="polite"><span className="text-gray-400">Примерное окончание</span><p className="tabular-nums text-accent-200">{timeline.length ? fmt(timeline.at(-1)!.end) : "Добавьте тайтл"}</p></div>
    </div>
    {candidates.length === 0 && <p role="alert" className="text-sm text-warning-200">Это время не существует в выбранном поясе или дата не заполнена. Проверьте переход летнего времени.</p>}
    {candidates.length > 1 && <label className="flex flex-wrap items-center gap-2 text-sm text-warning-200">Время повторяется при переводе часов<select className={field} value={Number.isFinite(startsAt) ? startsAt : ""} onChange={e => setFold(Number(e.target.value))}><option value="" disabled>Выберите первое или второе вхождение</option>{candidates.map((t, i) => <option key={t} value={t}>{i ? "Второе" : "Первое"} · {new Date(t * 1000).toISOString().slice(11, 16)} UTC</option>)}</select></label>}
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-accent-500" checked={skip} onChange={e => setSkip(e.target.checked)} /><span>Не учитывать опенинги и эндинги в плане<span className="mt-1 block text-xs text-gray-400">Оценка: −3 минуты на серию длиннее 3 минут. Для коротких выпусков длительность сохранена. Это не настройка автопропуска в плеере.</span></span></label>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0 space-y-5">
        {!blocks.length && <p className="rounded-lg bg-gray-900/50 p-5 text-sm text-gray-400">Добавьте аниме из комнаты. По умолчанию будут выбраны все доступные к началу сеанса серии.</p>}
        {blocks.map((b, i) => {
          const m = media.get(b.anilistId);
          const count = m ? episodeCount(m) : Math.max(...b.episodes, 0);
          const available = m ? Array.from({ length: count }, (_, k) => k + 1).filter(ep => episodeAvailability(m, ep, startsAt).selectable) : [];
          const currentPage = Math.min(page[b.anilistId] ?? 0, Math.max(0, Math.ceil(count / 100) - 1));
          const eps = Array.from({ length: Math.min(100, count - currentPage * 100) }, (_, k) => currentPage * 100 + k + 1);
          const watched = plan.queue.find(q => q.anilistId === b.anilistId)?.watchedEpisodes ?? [];
          return <section key={b.anilistId} className="min-w-0 border-b border-gray-700 pb-5" aria-label={title(b.anilistId)}>
            <div className="flex items-start gap-3">
              {m?.coverImage.large && <Img src={m.coverImage.large} size="thumb" className="h-20 w-14 shrink-0 rounded-md object-cover" />}
              <div className="min-w-0 flex-1"><h4 className="font-medium">{title(b.anilistId)}</h4><p className="mt-1 text-xs tabular-nums text-gray-400">{fmt(timeline[i].start)} — {fmt(timeline[i].end)}</p><p className="mt-1 break-words text-sm text-gray-300">Серии: {episodeLabel(b.episodes) || "не выбраны"}</p><p className="mt-1 text-xs text-gray-400">{b.durationMinutes} мин/серия · {b.durationSource === "catalog" ? "по каталогу" : "оценка, длительность неизвестна"}</p></div>
              <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                <Button size="sm" variant="ghost" type="button" disabled={i === 0 || saving} aria-label={`Поднять ${title(b.anilistId)}`} onClick={() => move(i, -1)}><ArrowUpIcon className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" type="button" disabled={i === blocks.length - 1 || saving} aria-label={`Опустить ${title(b.anilistId)}`} onClick={() => move(i, 1)}><ArrowDownIcon className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" type="button" disabled={saving} aria-label={`Убрать ${title(b.anilistId)}`} onClick={() => setBlocks(bs => bs.filter(x => x.anilistId !== b.anilistId))}><TrashIcon className="h-4 w-4" /></Button>
              </div>
            </div>
            <Button className="mt-3" size="sm" variant="ghost" type="button" aria-expanded={expanded === b.anilistId} onClick={() => setExpanded(expanded === b.anilistId ? null : b.anilistId)}>Выбрать серии · {b.episodes.length}</Button>
            {expanded === b.anilistId && <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => patch(b.anilistId, { episodes: [] })}>Сбросить</Button><Button type="button" size="sm" variant="ghost" onClick={() => patch(b.anilistId, { episodes: available })}>Отметить все</Button></div>
              <div className="grid select-none grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-2" onPointerMove={e => {
                if (!drag.current || e.pointerType !== "mouse") return;
                const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-session-ep]");
                if (target && e.currentTarget.contains(target)) range(Number(target.dataset.sessionEp));
              }} onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
                {eps.map(ep => {
                  const availability = m ? episodeAvailability(m, ep, startsAt) : { selectable: false };
                  const selected = b.episodes.includes(ep);
                  return <button key={ep} type="button" data-session-ep={ep} disabled={!availability.selectable || saving} aria-pressed={selected}
                    aria-label={`Серия ${ep}${watched.includes(ep) ? ", просмотрена группой" : ""}${availability.releaseAt ? ", выход " + fmt(availability.releaseAt) : !availability.selectable ? ", TBA" : ""}`}
                    title={availability.releaseAt ? `Выход: ${fmt(availability.releaseAt)}` : !availability.selectable ? "Дата выхода неизвестна" : watched.includes(ep) ? "Просмотрена группой" : `Серия ${ep}`}
                    className={cx("flex min-h-11 flex-col items-center justify-center rounded-md text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-300 motion-reduce:transition-none", watched.includes(ep) ? "bg-gray-700/60 text-gray-300" : selected ? "tone-accent soft" : "bg-gray-900 text-gray-300 hover:bg-gray-700", selected && "ring-2 ring-inset ring-accent-400", !availability.selectable && "cursor-not-allowed text-gray-400")}
                    onPointerDown={e => { mouseHandled.current = false; if (e.pointerType !== "mouse" || e.button !== 0) return; mouseHandled.current = true; drag.current = { id: b.anilistId, anchor: ep, selected: new Set(b.episodes), selecting: !selected, available: new Set(available) }; e.currentTarget.parentElement!.setPointerCapture(e.pointerId); range(ep); }}
                    onClick={e => { if (e.detail > 0 && mouseHandled.current) { mouseHandled.current = false; return; } patch(b.anilistId, { episodes: selected ? b.episodes.filter(n => n !== ep) : [...b.episodes, ep].sort((a, c) => a - c) }); }}>
                    <span>{ep}</span>{!availability.selectable && <span className="flex items-center gap-1 text-[10px]"><LockClosedIcon className="h-3 w-3" />{availability.releaseAt ? "Релиз" : "TBA"}</span>}
                  </button>;
                })}
              </div>
              {count === 0 && <p className="text-sm text-warning-200">Количество серий и даты пока неизвестны.</p>}
              {count > 100 && <div className="flex gap-2"><Button type="button" size="sm" disabled={!currentPage} onClick={() => setPage(p => ({ ...p, [b.anilistId]: currentPage - 1 }))}>Предыдущие 100</Button><Button type="button" size="sm" disabled={(currentPage + 1) * 100 >= count} onClick={() => setPage(p => ({ ...p, [b.anilistId]: currentPage + 1 }))}>Следующие 100</Button></div>}
              <p className="text-xs text-gray-400">Протяните мышью для диапазона. Серые — группой; их можно выбрать повторно. Рамка обозначает выбор.</p>
            </div>}
            {b.episodes.some(ep => !available.includes(ep)) && <p role="alert" className="mt-2 text-sm text-warning-200">Часть выбранных серий недоступна к началу сеанса. План не изменён автоматически.</p>}
            <label className="mt-4 flex flex-wrap items-center gap-2 text-sm text-gray-300">Перерыв после тайтла<input className={cx(field, "w-20 tabular-nums")} type="number" min={0} max={240} step={1} value={Number.isNaN(b.breakMinutes) ? "" : b.breakMinutes} onChange={e => patch(b.anilistId, { breakMinutes: e.target.value === "" ? NaN : Number(e.target.value) })} />мин{i === blocks.length - 1 && <span className="text-xs text-gray-400">Не входит в окончание: тайтл последний</span>}</label>
          </section>;
        })}
      </div>
      <aside className="min-w-0 space-y-3"><h4 className="text-sm font-medium">Добавить из комнаты</h4><input className={cx(field, "w-full")} aria-label="Поиск тайтла в комнате" placeholder="Название аниме" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="max-h-96 space-y-1 overflow-y-auto">{options.map(i => <button key={i.media.id} type="button" disabled={saving || blocks.length >= 50 || !Number.isFinite(startsAt)} onClick={() => { setBlocks(bs => [...bs, makeBlock(i.media, startsAt)]); setExpanded(i.media.id); }} className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left text-sm hover:bg-gray-700/50 focus-visible:outline-2 focus-visible:outline-accent-300 disabled:opacity-50">{i.media.coverImage.large && <Img src={i.media.coverImage.large} size="thumb" className="h-12 w-8 shrink-0 rounded object-cover" />}<span>{displayTitle(i.media.title)}<span className="block text-xs text-gray-400">{i.media.episodes ?? "?"} серий</span></span></button>)}{!options.length && <p className="text-sm text-gray-400">{search ? "По этому названию ничего не найдено." : list.items.length && list.items.every(i => blocks.some(b => b.anilistId === i.media.id)) ? "Все тайтлы комнаты уже в плане." : "Добавьте аниме в список комнаты или примите предложение в очередь."}</p>}</div>
      </aside>
    </div>
    {stale && <p role="alert" className="text-sm text-warning-200">Сеанс изменён другим участником. Закройте редактор и откройте новую версию.</p>}
    {saveFailed && <p role="alert" className="text-sm text-negative-200">Не удалось сохранить. Причина показана над редактором; ваши изменения остались здесь.</p>}
    <div className="flex flex-wrap items-center gap-3 border-t border-gray-700 pt-4"><Button type="submit" variant="primary" disabled={!canSave || saving}>{saving ? "Сохраняем…" : session ? "Сохранить изменения" : "Назначить сеанс"}</Button><Button type="button" variant="ghost" disabled={saving} onClick={onDone}>Отмена</Button><span className="text-xs text-gray-400">Перерывы перемещаются вместе с тайтлами. Время приблизительное.</span></div>
    </fieldset>
  </form>;
}
