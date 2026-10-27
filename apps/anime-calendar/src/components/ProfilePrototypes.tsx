"use client";
import { ChevronDownIcon, PencilIcon, PhotoIcon, TrophyIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { ProfileStatsResponse } from "@/app/api/users/[id]/stats/route";
import { achievementDef, GROUP_SHAPE, progressToNext, TIER_NAMES } from "@/lib/achievements";
import { api, useMe, useProfile } from "@/lib/client";
import { FORMAT_LABELS, GENRE_LABELS, label } from "@/lib/labels";
import type { RpgStats } from "@/lib/profile-rpg";
import { AchievementBadge, METAL } from "./AchievementBadge";
import { Avatar } from "./Avatar";
import { BadgeTile } from "./BadgeTile";
import { useHoverCard } from "./HoverCard";
import { AchievementCard } from "./AchievementsPreview";
import { AreaChart, Columns, Donut, Radar, StatBar } from "./charts";
import { Img } from "./Img";
import { Badge, Button, Modal, Segmented, Skel, SkelPosters, cx } from "./ui";

// Прототипы RPG-профиля на реальных данных: A — лист персонажа, B — инфографика, C — карточка игрока.

type Data = ProfileStatsResponse;
type User = { id: number; name: string };

const g = (x: string) => GENRE_LABELS[x] ?? x;
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const FORMAT_TONES = ["accent", "special", "info", "positive", "warning", "negative", "neutral"];

function Panel({ id, title, children, className, aside }: { id?: string; title?: string; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section id={id} className={cx("scroll-mt-20 rounded-2xl bg-gray-800/50 p-5 ring-1 ring-gray-700/80", className)}>
      {title && <div className="mb-4 flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">{title}</h3>{aside}</div>}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- общие блоки

const classTitle = (s: RpgStats) => (s.klass ? `${s.level.rank} ${s.klass.name.toLowerCase()}` : s.level.rank);

function GenreRadar({ s, size }: { s: RpgStats; size?: number }) {
  if (s.genres.length < 3) return <p className="text-sm text-gray-500">Мало просмотренного для «розы».</p>;
  return <Radar size={size} items={s.genres.map((x) => ({ label: g(x.genre), value: x.weight, hint: `${g(x.genre)}: ${x.count} тайтлов${x.mean ? `, средняя ${x.mean}` : ""}` }))} />;
}

function ScoreHist({ s }: { s: RpgStats }) {
  if (!s.scores.count) return <p className="text-sm text-gray-500">Оценок пока нет.</p>;
  const peak = s.scores.hist.indexOf(Math.max(...s.scores.hist));
  return (
    <>
      <Columns tone="warning" highlight={peak} items={s.scores.hist.map((v, i) => ({ label: String(i + 1), value: v }))} />
      <p className="mt-3 text-xs text-gray-400">
        Средняя <b className="text-gray-200">{s.scores.mean}</b>
        {s.scores.anilistMean !== null && <> · у тех же тайтлов на AniList — {s.scores.anilistMean} ({(s.scores.mean ?? 0) >= s.scores.anilistMean ? "щедрее" : "строже"} публики)</>}
      </p>
    </>
  );
}

const Eras = ({ s }: { s: RpgStats }) => <Columns tone="info" items={s.eras.map((e) => ({ label: `${String(e.from).slice(2)}–${String(e.from + 4).slice(2)}`, value: e.count, title: `${e.from}–${e.from + 4}: ${e.count}` }))} height={90} />;
const Activity = ({ s }: { s: RpgStats }) => <Columns tone="positive" items={s.activity.map((a) => ({ label: MONTHS[Number(a.month.slice(5)) - 1], value: a.count, title: `${a.month}: отметок ${a.count}` }))} height={90} />;

function Formats({ s }: { s: RpgStats }) {
  const items = s.formats.slice(0, 6).map((f, i) => ({ label: label(FORMAT_LABELS, f.format), value: f.count, tone: FORMAT_TONES[i] }));
  const total = items.reduce((a, b) => a + b.value, 0);
  return (
    <div className="flex items-center gap-5">
      <Donut items={items} size={120} center={<><b className="text-lg">{total}</b><span className="text-[10px] text-gray-500">тайтлов</span></>} />
      <ul className="space-y-1 text-xs">
        {items.map((it) => <li key={it.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--color-${it.tone}-400)` }} />{it.label}<span className="text-gray-500">{it.value}</span></li>)}
      </ul>
    </div>
  );
}

function Hall({ s, size = "md" }: { s: RpgStats; size?: "md" | "lg" }) {
  if (!s.hall.length) return <p className="text-sm text-gray-500">Нет тайтлов с оценкой от 8.</p>;
  return (
    <div className={cx("grid gap-3", size === "lg" ? "grid-cols-4 sm:grid-cols-8" : "grid-cols-4")}>
      {s.hall.map((h) => (
        <Link key={h.id} href={`/anime/${h.id}`} title={h.title} className="group relative block aspect-[2/3] overflow-hidden rounded-lg ring-1 ring-gray-700" style={{ backgroundColor: h.color ?? undefined }}>
          {h.cover && <Img src={h.cover} size="card" className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105" />}
          <span className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[11px] font-bold text-warning-300">★ {h.score}</span>
        </Link>
      ))}
    </div>
  );
}

function Records({ s }: { s: RpgStats }) {
  return (
    <ul className="space-y-2.5">
      {s.records.map((r) => (
        <li key={r.kind} className="text-sm">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">{r.label}</p>
          <p className="truncate"><Link href={`/anime/${r.id}`} className="hover:text-accent-300">{r.title}</Link> <span className="text-gray-400">· {r.value}</span></p>
        </li>
      ))}
    </ul>
  );
}

function Awards({ d, count = 8, size = 60 }: { d: Data; count?: number; size?: number }) {
  const best = d.achievements.filter((a) => a.tier > 0).sort((a, b) => b.tier - a.tier || b.value - a.value).slice(0, count);
  if (!best.length) return <p className="text-sm text-gray-500">Наград пока нет.</p>;
  return (
    <div className="flex flex-wrap gap-4">
      {best.map((a) => {
        const def = achievementDef(a.id)!;
        return (
          <div key={a.id} className="flex w-20 flex-col items-center gap-1.5 text-center" title={`${def.name} — ${TIER_NAMES[a.tier]}`}>
            <AchievementBadge icon={def.icon} tier={a.tier} shape={GROUP_SHAPE[def.group]} size={size} progress={progressToNext(a.value, def.thresholds).ratio} />
            <span className="text-[11px] leading-tight text-gray-300">{def.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function Portrait({ d }: { d: Data }) {
  const [full, setFull] = useState(false);
  if (!d.portrait) return <p className="text-sm text-gray-500">Портрет вкуса появится после первого расчёта «Для тебя».</p>;
  return (
    <div>
      <p className={cx("text-sm italic leading-relaxed text-gray-300", !full && "line-clamp-6")}>«{d.portrait.text}»</p>
      {d.portrait.text.length > 300 && <button onClick={() => setFull(!full)} className="mt-1 text-xs text-accent-300 hover:text-accent-200">{full ? "Свернуть" : "Полностью"}</button>}
    </div>
  );
}

/** Кольцо уровня вокруг аватара. */
function LevelRing({ user, s, size = 112, avatar }: { user: User; s: RpgStats; size?: number; avatar?: React.ReactNode }) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
        <circle cx="50" cy="50" r="47" fill="none" stroke="var(--color-neutral-800)" strokeWidth="4" />
        <circle cx="50" cy="50" r="47" fill="none" stroke="var(--color-warning-400)" strokeWidth="4" strokeLinecap="round" pathLength={100} strokeDasharray={`${s.level.progress * 100} 100`} />
      </svg>
      <div className="absolute inset-[7%]">{avatar ?? <Avatar user={user} className="h-full w-full text-4xl" />}</div>
      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-bold text-warning-300 ring-1 ring-warning-500/50">ур. {s.level.level}</span>
    </div>
  );
}

// ---------------------------------------------------------------- A · лист персонажа

function VariantA({ user, d }: { user: User; d: Data }) {
  const s = d.stats;
  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl p-6 ring-1 ring-warning-500/30" style={{ background: "radial-gradient(120% 140% at 0% 0%, color-mix(in oklch, var(--color-warning-500) 14%, transparent), transparent 60%), var(--color-gray-900, #111827)" }}>
        <div className="flex flex-wrap items-center gap-6">
          <LevelRing user={user} s={s} />
          <div className="min-w-0 flex-1">
            <h2 className="text-3xl font-bold">{user.name}</h2>
            <p className="mt-1 text-lg text-warning-200">{classTitle(s)}{s.klass?.second && <span className="text-gray-400"> · второй путь — {g(s.klass.second).toLowerCase()}</span>}</p>
            {s.klass && <p className="text-sm italic text-gray-400">«{s.klass.motto}»</p>}
            <div className="mt-3 max-w-md">
              <div className="mb-1 flex justify-between text-xs text-gray-400"><span>Опыт: {s.level.xp}</span><span>до {s.level.level + 1} ур. — {s.level.toNext}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-gray-800"><div className="h-full rounded-full bg-linear-to-r from-warning-600 to-warning-300" style={{ width: `${s.level.progress * 100}%` }} /></div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-center">
            {[["Досмотрено", s.totals.completed], ["Серий", s.totals.episodes], ["Брошено", s.totals.dropped], ["Смотрю", s.totals.watching], ["В планах", s.totals.planned], ["Оценок", s.scores.count]].map(([l, v]) => (
              <div key={l as string}><p className="text-xl font-bold tabular-nums">{v}</p><p className="text-[11px] text-gray-500">{l}</p></div>
            ))}
          </div>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Panel title="Атрибуты"><div className="space-y-3">{s.attributes.map((a) => <StatBar key={a.key} name={a.name} value={a.value} hint={a.hint} tone="warning" />)}</div></Panel>
        <Panel title="Стихии — роза жанров"><div className="mx-auto max-w-sm"><GenreRadar s={s} /></div></Panel>
      </div>
      <Panel title="Награды" aside={<span className="text-xs text-gray-500">{d.achievements.filter((a) => a.tier > 0).length} получено</span>}><Awards d={d} /></Panel>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Зал славы" className="lg:col-span-2"><Hall s={s} /></Panel>
        <Panel title="Летопись подвигов"><Records s={s} /></Panel>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Характеристика" className="lg:col-span-1"><Portrait d={d} /></Panel>
        <Panel title="Оценки"><ScoreHist s={s} /></Panel>
        <Panel title="Эпохи"><Eras s={s} /></Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- B · инфографика

function VariantB({ user, d }: { user: User; d: Data }) {
  const s = d.stats;
  const kpi: [string, string | number, string][] = [
    ["часов", s.totals.hours, `${Math.floor(s.totals.hours / 24)} дн.`], ["досмотрено", s.totals.completed, `из ${s.totals.titles}`],
    ["серий", s.totals.episodes, ""], ["средняя", s.scores.mean ?? "—", s.scores.anilistMean ? `AniList ${s.scores.anilistMean}` : ""],
    ["уровень", s.level.level, s.level.rank],
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar user={user} className="h-16 w-16 text-2xl" />
        <div><h2 className="text-2xl font-bold">{user.name}</h2><p className="text-sm text-gray-400">{classTitle(s)}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {kpi.map(([l, v, sub]) => (
          <div key={l} className="rounded-2xl bg-gray-800/50 p-4 ring-1 ring-gray-700/80">
            <p className="text-3xl font-bold tabular-nums">{v}</p>
            <p className="text-xs text-gray-400">{l}{sub && <span className="text-gray-500"> · {sub}</span>}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Жанры"><GenreRadar s={s} size={260} /></Panel>
        <Panel title="Оценки"><ScoreHist s={s} /></Panel>
        <Panel title="Форматы"><Formats s={s} /><div className="mt-5"><p className="mb-2 text-xs text-gray-500">Студии</p>
          <ul className="space-y-1 text-sm">{s.studios.map((x) => <li key={x.name} className="flex justify-between"><span className="truncate">{x.name}</span><span className="text-gray-500">{x.count}</span></li>)}</ul></div></Panel>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Годы выхода просмотренного"><Eras s={s} /></Panel>
        <Panel title="Активность за год"><Activity s={s} /></Panel>
      </div>
      <Panel title="Любимое"><Hall s={s} size="lg" /></Panel>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Рекорды"><Records s={s} /></Panel>
        <Panel title="Вкус"><Portrait d={d} /></Panel>
        <Panel title="Профиль зрителя"><div className="space-y-2.5">{s.attributes.map((a) => <StatBar key={a.key} name={a.name} value={a.value} hint={a.hint} />)}</div></Panel>
      </div>
      <Panel title="Награды"><Awards d={d} count={12} size={52} /></Panel>
    </div>
  );
}

// ---------------------------------------------------------------- C · карточка игрока

function VariantC({ user, d }: { user: User; d: Data }) {
  const s = d.stats;
  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl ring-1 ring-gray-700">
        {s.banner && <Img src={s.banner} size="full" className="absolute inset-0 h-full w-full object-cover opacity-45" />}
        <div className="absolute inset-0 bg-linear-to-t from-gray-950 via-gray-950/75 to-gray-950/20" />
        <div className="relative flex flex-wrap items-end gap-6 p-6 pt-24">
          <LevelRing user={user} s={s} size={124} />
          <div className="min-w-0 flex-1 pb-1">
            <h2 className="text-3xl font-bold drop-shadow">{user.name}</h2>
            <p className="text-lg text-accent-200">{classTitle(s)}</p>
            {s.klass && <p className="text-sm text-gray-300">«{s.klass.motto}»</p>}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {s.genres.slice(0, 4).map((x) => <span key={x.genre} className="tone-accent soft rounded-full px-2.5 py-1">{g(x.genre)}</span>)}
            </div>
          </div>
          <div className="pb-1"><Awards d={d} count={5} size={54} /></div>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Характеристики"><div className="mx-auto max-w-sm"><Radar size={300} tone="special" items={s.attributes.map((a) => ({ label: a.name, value: a.value / 100, hint: `${a.name}: ${a.value} — ${a.hint}` }))} /></div></Panel>
        <Panel title="Жанры"><div className="mx-auto max-w-sm"><GenreRadar s={s} size={300} /></div></Panel>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Сводка">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {[["Часов", s.totals.hours], ["Досмотрено", s.totals.completed], ["Серий", s.totals.episodes], ["Средняя", s.scores.mean ?? "—"], ["Смотрю", s.totals.watching], ["Брошено", s.totals.dropped]].map(([l, v]) => (
              <div key={l as string}><dt className="text-[11px] uppercase tracking-wider text-gray-500">{l}</dt><dd className="text-xl font-bold tabular-nums">{v}</dd></div>
            ))}
          </dl>
          <div className="mt-5"><Formats s={s} /></div>
        </Panel>
        <Panel title="Рекорды"><Records s={s} /><div className="mt-5 border-t border-gray-700 pt-4"><Portrait d={d} /></div></Panel>
      </div>
      <Panel title="Коллекция — лучшее"><Hall s={s} size="lg" /></Panel>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Оценки"><ScoreHist s={s} /></Panel>
        <Panel title="Эпохи"><Eras s={s} /></Panel>
        <Panel title="Активность"><Activity s={s} /></Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- D · итоговый (по отзыву)

function Expander({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-sm text-accent-300 hover:text-accent-200">
        <ChevronDownIcon className={cx("h-4 w-4 transition", open && "rotate-180")} />{label}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** Ссылка на тайтл со всплывающей карточкой при наведении. */
function HoverLink({ id, className, style, title, children }: { id: number; className?: string; style?: React.CSSProperties; title?: string; children: React.ReactNode }) {
  const hover = useHoverCard(id);
  return <Link {...hover} href={`/anime/${id}`} className={className} style={style} aria-label={title}>{children}</Link>;
}

function HallPicker({ d, open, onClose, onSave }: { d: Data; open: boolean; onClose: () => void; onSave: (ids: number[] | null) => void }) {
  const [picked, setPicked] = useState<number[]>(d.hall.chosen ? d.hall.items.map((h) => h.id) : []);
  const [q, setQ] = useState("");
  const items = d.hallOptions.filter((o) => o.title.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? p : [...p, id]));
  return (
    <Modal open={open} onClose={onClose} title={`Зал славы — ${picked.length} из 10`} wide>
      <div className="space-y-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в моих тайтлах…"
          className="h-9 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm focus:border-accent-500 focus:outline-none" />
        <div className="grid max-h-[50vh] grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
          {items.map((o) => {
            const n = picked.indexOf(o.id);
            return (
              <button key={o.id} onClick={() => toggle(o.id)} title={o.title}
                className={cx("relative aspect-[2/3] overflow-hidden rounded-lg ring-2 transition", n >= 0 ? "ring-accent-400" : "ring-transparent opacity-80 hover:opacity-100")}
                style={{ backgroundColor: o.color ?? undefined }}>
                {o.cover && <Img src={o.cover} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
                {n >= 0 && <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-600 text-[11px] font-bold">{n + 1}</span>}
                {o.score > 0 && <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-1 text-[10px] font-bold text-warning-300">★ {o.score}</span>}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-500">Порядок — как выбирали. Без выбора показываются лучшие по оценке.</p>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onSave(null)}>Лучшие по оценке</Button>
          <Button variant="primary" onClick={() => onSave(picked)}>Сохранить</Button>
        </div>
      </div>
    </Modal>
  );
}

function AllRatings({ d }: { d: Data }) {
  const by = new Map<number, Data["ratings"]>();
  for (const r of d.ratings) by.set(r.score, [...(by.get(r.score) ?? []), r]);
  return (
    <div className="space-y-4">
      {[...by].sort((a, b) => b[0] - a[0]).map(([score, items]) => (
        <div key={score} className="flex gap-4">
          <div className="w-14 shrink-0 pt-1 text-center">
            <p className="text-2xl font-bold text-warning-300">{score}</p>
            <p className="text-[11px] text-gray-500">{items.length} шт.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {items.map((r) => (
              <HoverLink key={r.id} id={r.id} className="relative block aspect-[2/3] w-14 overflow-hidden rounded-md ring-1 ring-gray-700 transition hover:ring-accent-400" style={{ backgroundColor: r.color ?? undefined }}>
                {r.cover && <Img src={r.cover} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
              </HoverLink>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BannerPicker({ d, open, onClose, onSave }: { d: Data; open: boolean; onClose: () => void; onSave: (id: number | null) => void }) {
  const [q, setQ] = useState("");
  const items = d.bannerOptions.filter((o) => o.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Баннер профиля" wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в моих тайтлах…"
            className="h-9 flex-1 rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm focus:border-accent-500 focus:outline-none" />
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>По умолчанию (лучшая оценка)</Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map((o) => (
            <button key={o.id} onClick={() => onSave(o.id)} className={cx("group relative h-20 overflow-hidden rounded-lg text-left ring-2 transition",
              d.banner?.id === o.id ? "ring-accent-400" : "ring-transparent hover:ring-gray-500")}>
              <Img src={o.image} size="full" className="absolute inset-0 h-full w-full object-cover" />
              <span className="absolute inset-0 bg-linear-to-r from-gray-950/85 via-gray-950/30 to-transparent" />
              <span className="relative block p-3 text-sm font-semibold leading-tight">{o.title}{o.score > 0 && <span className="ml-1.5 text-warning-300">★ {o.score}</span>}</span>
            </button>
          ))}
        </div>
        {!items.length && <p className="text-sm text-gray-500">Нет тайтлов с баннером.</p>}
      </div>
    </Modal>
  );
}

function ShowcasePicker({ d, open, onClose, onSave }: { d: Data; open: boolean; onClose: () => void; onSave: (ids: string[] | null) => void }) {
  const earned = d.achievements.filter((a) => a.tier > 0).sort((a, b) => b.tier - a.tier || b.value - a.value);
  const [picked, setPicked] = useState<string[]>(d.showcase.ids);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 6 ? p : [...p, id]));
  return (
    <Modal open={open} onClose={onClose} title={`Витрина наград — ${picked.length} из 6`} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          {earned.map((a) => {
            const def = achievementDef(a.id)!;
            const on = picked.includes(a.id);
            return (
              <button key={a.id} onClick={() => toggle(a.id)} title={`${def.name} — ${TIER_NAMES[a.tier]}`}
                className={cx("flex w-20 flex-col items-center gap-1.5 rounded-xl p-2 text-center transition", on ? "tone-accent soft" : "opacity-60 hover:opacity-100")}>
                <AchievementBadge icon={def.icon} tier={a.tier} shape={GROUP_SHAPE[def.group]} size={52} progress={progressToNext(a.value, def.thresholds).ratio} />
                <span className="text-[11px] leading-tight">{def.name}</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => onSave(null)}>Самые прокачанные</Button>
          <Button variant="primary" onClick={() => onSave(picked)}>Сохранить</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Итоговый RPG-профиль (вариант D): actions — кнопки в шапке (дружба), avatar — свой аватар (редактор). */
export function RpgProfile({ user, d, self, actions, avatar, extra }: {
  user: User; d: Data; self: boolean; actions?: React.ReactNode; avatar?: React.ReactNode; extra?: React.ReactNode;
}) {
  return <VariantD user={user} d={d} self={self} actions={actions} avatar={avatar} extra={extra} />;
}

const TOTAL_LABELS = ["Часов", "Тайтлов", "Досмотрено", "Серий", "Смотрю", "В планах", "Брошено", "Средняя"];

/** Заглушка профиля, пока считается статистика: те же блоки и заголовки, вместо цифр — плашки.
 *  Пользователь известен (профиль пришёл раньше статистики) — имя, аватар и кнопки уже настоящие. */
export function RpgProfileSkeleton({ user, actions, avatar, extra }: {
  user?: User; actions?: React.ReactNode; avatar?: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-5" aria-busy>
      <div className="relative z-10 rounded-2xl ring-1 ring-gray-700">
        <div className="absolute inset-0 overflow-hidden rounded-2xl"><div className="absolute inset-0 bg-linear-to-t from-gray-950 via-gray-950/70 to-gray-950/10" /></div>
        {actions && <div className="absolute right-3 top-3 z-10 flex gap-2">{actions}</div>}
        <div className="relative flex flex-wrap items-end gap-6 p-6 pt-28">
          <div className="relative" style={{ width: 124, height: 124 }}>
            {user
              ? <div className="absolute inset-[7%]">{avatar ?? <Avatar user={user} className="h-full w-full text-4xl" />}</div>
              : <Skel className="h-full w-full rounded-full" />}
          </div>
          <div className="min-w-0 flex-1 space-y-2 pb-1">
            {user ? <h2 className="text-3xl font-bold drop-shadow">{user.name}</h2> : <Skel className="h-9 w-48" />}
            <Skel className="h-5 w-56" />
            <Skel className="h-1.5 w-full max-w-sm rounded-full" />
            <div className="flex gap-1.5 pt-1">{[0, 1, 2].map((i) => <Skel key={i} className="h-6 w-20 rounded-full" />)}</div>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {TOTAL_LABELS.map((l) => (
          <div key={l} className="rounded-2xl bg-gray-800/50 px-4 py-3 ring-1 ring-gray-700/80">
            <Skel className="my-1 h-6 w-14" />
            <p className="text-xs text-gray-400">{l}</p>
          </div>
        ))}
      </div>
      {extra}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Panel title="Атрибуты"><div className="space-y-3.5">{[0, 1, 2, 3, 4, 5].map((i) => <Skel key={i} className="h-8 w-full" />)}</div></Panel>
        <Panel title="Стихии — роза жанров"><Skel className="mx-auto aspect-square w-full max-w-80 rounded-full" /></Panel>
      </div>
      <Panel title="Награды"><div className="flex flex-wrap gap-3">{Array.from({ length: 8 }, (_, i) => <Skel key={i} className="h-20 w-20 rounded-xl" />)}</div></Panel>
      <Panel title="Зал славы"><SkelPosters count={10} className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-10" /></Panel>
    </div>
  );
}

function VariantD({ user, d, self, actions, avatar, extra }: {
  user: User; d: Data; self: boolean; actions?: React.ReactNode; avatar?: React.ReactNode; extra?: React.ReactNode;
}) {
  const s = d.stats;
  const qc = useQueryClient();
  const [pick, setPick] = useState<"banner" | "showcase" | "hall" | null>(null);
  const save = async (body: Record<string, unknown>) => {
    setPick(null);
    await api("/api/me", { method: "PATCH", json: body });
    void qc.invalidateQueries({ queryKey: ["profile-stats", user.id] });
  };
  const earned = d.achievements.filter((a) => a.tier > 0);
  const tiers = ([4, 3, 2, 1] as const).map((t) => [t, earned.filter((a) => a.tier === t).length] as const);
  const curve = d.weekly
    ? d.weekly.map((w) => ({ label: new Date(w.week * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }), value: w.hours, title: `неделя с ${new Date(w.week * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: ${w.hours} ч, ${w.episodes} серий` }))
    : s.activity.map((a) => ({ label: MONTHS[Number(a.month.slice(5)) - 1], value: a.count, title: `${MONTHS[Number(a.month.slice(5)) - 1]} ${a.month.slice(0, 4)}: отметок ${a.count}` }));

  return (
    <div className="space-y-5">
      {/* Шапка: баннер, уровень, витрина */}
      <div className="relative z-10 rounded-2xl ring-1 ring-gray-700">
        <div className="absolute inset-0 overflow-hidden rounded-2xl">
          {d.banner && <Img src={d.banner.image} size="full" className="absolute inset-0 h-full w-full object-cover opacity-50" />}
          <div className="absolute inset-0 bg-linear-to-t from-gray-950 via-gray-950/70 to-gray-950/10" />
        </div>
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          {actions}
          {self && (
            <>
              <Button size="sm" onClick={() => setPick("banner")}><PhotoIcon className="h-4 w-4" />Баннер</Button>
              <Button size="sm" onClick={() => setPick("showcase")}><TrophyIcon className="h-4 w-4" />Витрина</Button>
            </>
          )}
        </div>
        <div className="relative flex flex-wrap items-end gap-6 p-6 pt-28">
          <LevelRing user={user} s={s} size={124} avatar={avatar} />
          <div className="min-w-0 flex-1 pb-1">
            <h2 className="text-3xl font-bold drop-shadow">{user.name}</h2>
            <p className="text-base text-warning-200">Уровень {s.level.level} · {s.level.rank}</p>
            <div className="group relative mt-2 max-w-sm">
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-800/80"><div className="h-full rounded-full bg-linear-to-r from-warning-600 to-warning-300" style={{ width: `${s.level.progress * 100}%` }} /></div>
              <p className="mt-1 flex justify-between gap-3 text-xs text-gray-300">
                <span><b className="tabular-nums text-warning-200">{s.level.inLevel.toLocaleString("ru-RU")}</b> / {s.level.levelSize.toLocaleString("ru-RU")} опыта</span>
                <span className="text-gray-400">до {s.level.level + 1}-го уровня — {s.level.toNext.toLocaleString("ru-RU")}</span>
              </p>
              <div className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-72 rounded-xl bg-gray-900/97 p-3 text-xs opacity-0 shadow-2xl ring-1 ring-gray-700 transition group-hover:visible group-hover:opacity-100">
                <p className="text-gray-200">Опыт — сумма опыта всех наград: <b>{s.level.xp.toLocaleString("ru-RU")}</b></p>
                <p className="mt-1 text-gray-400">«Время просмотра»: {s.level.fromHours.toLocaleString("ru-RU")} (10 за час, {s.totals.hours} ч)</p>
                <p className="text-gray-400">Остальные награды: {s.level.fromBadges.toLocaleString("ru-RU")} (бронза 20, серебро 50, золото 120, платина 300)</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              {s.genres.slice(0, 4).map((x) => <span key={x.genre} className="tone-accent soft rounded-full px-2.5 py-1">{g(x.genre)}</span>)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pb-1">
            {d.showcase.ids.map((id) => <BadgeTile key={id} a={d.achievements.find((x) => x.id === id)!} hours={s.totals.hours} />)}
          </div>
        </div>
        {d.banner && <p className="absolute bottom-2 right-3 text-[10px] text-gray-500">баннер: {d.banner.title}</p>}
      </div>

      {/* Общие цифры */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {([
          ["Часов", s.totals.hours.toLocaleString("ru-RU"), `${Math.floor(s.totals.hours / 24)} дн. без сна`],
          ["Тайтлов", s.totals.titles, "в списках"],
          ["Досмотрено", s.totals.completed, ""],
          ["Серий", s.totals.episodes.toLocaleString("ru-RU"), ""],
          ["Смотрю", s.totals.watching, ""],
          ["В планах", s.totals.planned, ""],
          ["Брошено", s.totals.dropped, ""],
          ["Средняя", s.scores.mean ?? "—", s.scores.count ? `оценок ${s.scores.count}` : "оценок нет"],
        ] as const).map(([l, v, sub]) => (
          <div key={l} className="rounded-2xl bg-gray-800/50 px-4 py-3 ring-1 ring-gray-700/80">
            <p className="text-2xl font-bold tabular-nums">{v}</p>
            <p className="text-xs text-gray-400">{l}{sub && <span className="text-gray-500"> · {sub}</span>}</p>
          </div>
        ))}
      </div>

      {extra}

      {/* Атрибуты и стихии */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Panel title="Атрибуты" aside={<span className="text-xs text-gray-500">наведите — что это</span>}>
          <div className="space-y-3.5">{s.attributes.map((a) => <StatBar key={a.key} name={a.name} value={a.value} hint={a.hint} desc={a.desc} tone="warning" />)}</div>
        </Panel>
        <Panel title="Стихии — роза жанров"><div className="mx-auto max-w-md"><GenreRadar s={s} size={320} /></div></Panel>
      </div>

      {/* Награды: сводка + лучшие + все под раскрывашкой */}
      <Panel id="awards" title="Награды" aside={<span className="text-xs text-gray-500">{earned.length} получено · наведите на значок</span>}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {tiers.map(([t, n]) => <span key={t} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-full" style={{ background: `linear-gradient(135deg, ${METAL[t].from}, ${METAL[t].to})` }} />{TIER_NAMES[t]}: <b>{n}</b></span>)}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {[...earned].sort((a, b) => b.tier - a.tier || b.value - a.value).slice(0, 10).map((a) => <BadgeTile key={a.id} a={a} hours={s.totals.hours} />)}
        </div>
        <Expander label={`Все награды (${d.achievements.length})`}>
          <div className="flex flex-wrap gap-3">
            {[...d.achievements].sort((a, b) => b.tier - a.tier || progressToNext(b.value, achievementDef(b.id)!.thresholds).ratio - progressToNext(a.value, achievementDef(a.id)!.thresholds).ratio)
              .map((a) => <BadgeTile key={a.id} a={a} hours={s.totals.hours} />)}
          </div>
        </Expander>
      </Panel>

      {/* Зал славы (выбор пользователя) + все оценки */}
      <Panel title="Зал славы" aside={self ? <Button size="sm" variant="ghost" onClick={() => setPick("hall")}><PencilIcon className="h-4 w-4" />Выбрать</Button> : undefined}>
        {d.hall.items.length ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-10">
            {d.hall.items.map((h) => (
              <HoverLink key={h.id} id={h.id} title={h.title} className="group relative block aspect-[2/3] overflow-hidden rounded-lg ring-1 ring-gray-700" style={{ backgroundColor: h.color ?? undefined }}>
                {h.cover && <Img src={h.cover} size="card" className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-105" />}
                {h.score > 0 && <span className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-[11px] font-bold text-warning-300">★ {h.score}</span>}
              </HoverLink>
            ))}
          </div>
        ) : <p className="text-sm text-gray-500">{self ? "Выберите до 10 любимых тайтлов." : "Пока пусто."}</p>}
        {d.ratings.length > 0 && <Expander label={`Все оценки (${d.ratings.length})`}><AllRatings d={d} /></Expander>}
      </Panel>

      {/* Характеристика — крупно */}
      <Panel title="Характеристика">
        {d.portrait ? (
          <div className="space-y-4">
            <p className="text-base leading-relaxed text-gray-200">{d.portrait.text}</p>
            <div className="flex flex-wrap gap-1.5">
              {d.portrait.likes.map((x) => <Badge key={x} tone="positive">{x}</Badge>)}
              {d.portrait.dislikes.map((x) => <Badge key={x} tone="negative">{x}</Badge>)}
            </div>
          </div>
        ) : <Portrait d={d} />}
      </Panel>

      {/* Достижения — рекорды зрителя */}
      <Panel title="Достижения">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {s.records.map((r) => (
            <HoverLink key={r.kind} id={r.id} className="block rounded-xl bg-gray-900/40 p-3 ring-1 ring-gray-700/70 transition hover:ring-accent-500/50">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">{r.label}</p>
              <p className="mt-0.5 truncate font-medium">{r.title}</p>
              <p className="text-xs text-gray-400">{r.value}</p>
            </HoverLink>
          ))}
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Оценки"><ScoreHist s={s} /></Panel>
        <Panel title="Эпохи — годы выхода просмотренного"><Eras s={s} /></Panel>
      </div>

      <Panel title="Активность" aside={<span className="text-xs text-gray-500">{d.weekly ? "часы просмотра по неделям" : "отметки по месяцам — журнал просмотра только начал копиться"}</span>}>
        <AreaChart points={curve} format={(v) => (d.weekly ? `${v} ч` : String(v))} />
      </Panel>

      <HallPicker key={d.hall.items.map((h) => h.id).join()} d={d} open={pick === "hall"} onClose={() => setPick(null)} onSave={(ids) => save({ hall: ids })} />
      {d.banner && <BannerPicker d={d} open={pick === "banner"} onClose={() => setPick(null)} onSave={(id) => save({ profileBanner: id })} />}
      <ShowcasePicker key={d.showcase.ids.join()} d={d} open={pick === "showcase"} onClose={() => setPick(null)} onSave={(ids) => save({ showcase: ids })} />
    </div>
  );
}

export function ProfilePrototypes({ userId }: { userId?: number }) {
  const { data: me } = useMe();
  const id = userId ?? me?.id ?? 0;
  const { data: profile } = useProfile(id);
  const { data, isLoading, error } = useQuery({ queryKey: ["profile-stats", id], queryFn: () => api<Data>(`/api/users/${id}/stats`), enabled: id > 0 });
  const [v, setV] = useState<"A" | "B" | "C" | "D">("D");
  if (isLoading || !data || !profile) return error ? <p className="text-negative-300">{String(error)}</p> : <div className="max-w-7xl"><RpgProfileSkeleton user={profile?.user} /></div>;
  return (
    <div className="max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="mr-auto text-2xl font-bold sm:text-3xl">Профиль — прототипы</h1>
        <Segmented value={v} onChange={setV} options={[["D", "D · Итоговый"], ["A", "A · Лист персонажа"], ["B", "B · Инфографика"], ["C", "C · Карточка игрока"]]} />
      </div>
      {v === "D" ? <VariantD user={profile.user} d={data} self={profile.self} /> : v === "A" ? <VariantA user={profile.user} d={data} /> : v === "B" ? <VariantB user={profile.user} d={data} /> : <VariantC user={profile.user} d={data} />}
      <p className="text-xs text-gray-500">Металлы уровня: {Object.values(METAL).length - 1} ступени, как у наград. Активность — по датам отметок (импортированная история попадает в месяц импорта).</p>
    </div>
  );
}
