"use client";
import {
  ArchiveBoxIcon, BoltIcon, CalendarDaysIcon, ChatBubbleLeftRightIcon, CheckBadgeIcon, ClockIcon, CloudIcon, CogIcon,
  ExclamationTriangleIcon, EyeIcon, FaceSmileIcon, FilmIcon, FireIcon, FlagIcon, GlobeAltIcon, HandThumbUpIcon, HeartIcon,
  LightBulbIcon, MagnifyingGlassIcon, MapIcon, MoonIcon, MusicalNoteIcon, PencilSquareIcon, PuzzlePieceIcon, RocketLaunchIcon,
  ScaleIcon, SignalIcon, SparklesIcon, Squares2X2Icon, StarIcon, SunIcon, TrophyIcon, UserGroupIcon, UsersIcon,
} from "@heroicons/react/24/outline";
import { useId } from "react";
import type { AchievementIcon, Tier } from "@/lib/achievements";

// Значок награды. Форма — по типу (грань — жанры, жетон — привычки, щит — друзья, ромб — события).
// Внешняя обводка — прогресс к следующему уровню (заполняется цветом этого уровня), внутренний контур и
// значок — цвет текущего уровня. Металлы — мягкие градиенты; у платины — медленный блик.

export const ICONS: Record<AchievementIcon, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  bolt: BoltIcon, heart: HeartIcon, smile: FaceSmileIcon, sparkles: SparklesIcon, rocket: RocketLaunchIcon, cog: CogIcon,
  trophy: TrophyIcon, eye: EyeIcon, moon: MoonIcon, sun: SunIcon, search: MagnifyingGlassIcon, music: MusicalNoteIcon,
  clock: ClockIcon, calendar: CalendarDaysIcon, archive: ArchiveBoxIcon, flag: FlagIcon, scale: ScaleIcon,
  chat: ChatBubbleLeftRightIcon, users: UsersIcon, map: MapIcon, thumb: HandThumbUpIcon, puzzle: PuzzlePieceIcon,
  globe: GlobeAltIcon, alert: ExclamationTriangleIcon, star: StarIcon, film: FilmIcon, pencil: PencilSquareIcon,
  squares: Squares2X2Icon, check: CheckBadgeIcon, signal: SignalIcon, userGroup: UserGroupIcon, bulb: LightBulbIcon,
  cloud: CloudIcon, fire: FireIcon,
};

/** Градиент металла: [светлый, тёмный] и цвет значка внутри. */
export const METAL: Record<Tier, { from: string; to: string; ink: string }> = {
  0: { from: "#4b5563", to: "#374151", ink: "#6b7280" },
  1: { from: "#d6a273", to: "#8a5a35", ink: "#d9a77a" },
  2: { from: "#f1f3f6", to: "#9aa3b0", ink: "#dfe3e8" },
  3: { from: "#f5dc95", to: "#b8913f", ink: "#f0d184" },
  4: { from: "#e4f8fb", to: "#7fbccd", ink: "#d3f1f6" },
};

export type BadgeShape = "hex" | "coin" | "shield" | "diamond";

/** Контуры в квадрате 100×100; начинаются сверху по центру — прогресс растёт по часовой от верхушки. */
const SHAPES: Record<BadgeShape, string> = {
  coin: "M50 6 A44 44 0 1 1 49.99 6 Z",
  hex: "M50 5 L89 27.5 L89 72.5 L50 95 L11 72.5 L11 27.5 Z",
  shield: "M50 5 L87 17 L87 47 C87 71 70 87 50 95 C30 87 13 71 13 47 L13 17 Z",
  diamond: "M50 4 L96 50 L50 96 L4 50 Z",
};

export function AchievementBadge({ icon, tier, shape = "coin", size = 64, progress = 0 }: {
  icon: AchievementIcon; tier: Tier; shape?: BadgeShape; size?: number; progress?: number;
}) {
  const id = useId().replace(/:/g, "");
  const cur = METAL[tier];
  const next = METAL[Math.min(4, tier + 1) as Tier];
  const Icon = ICONS[icon];
  const d = SHAPES[shape];
  const done = tier === 4;
  const p = done ? 100 : Math.max(0, Math.min(1, progress)) * 100;

  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`c${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={cur.from} /><stop offset="1" stopColor={cur.to} /></linearGradient>
          <linearGradient id={`n${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={next.from} /><stop offset="1" stopColor={next.to} /></linearGradient>
          {done && (
            <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0.6" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
              <animateTransform attributeName="gradientTransform" type="translate" from="-1 0" to="1 0" dur="3.2s" repeatCount="indefinite" />
            </linearGradient>
          )}
        </defs>
        {/* Тело: тёмное, с лёгким оттенком текущего металла */}
        <path d={d} fill="#111827" />
        {tier > 0 && <path d={d} fill={`url(#c${id})`} fillOpacity="0.1" />}
        {/* Внешняя обводка: дорожка и прогресс к следующему уровню */}
        <path d={d} fill="none" stroke="#2d3748" strokeWidth="6" strokeLinejoin="round" />
        {p > 0 && (
          <path d={d} fill="none" stroke={`url(#${done ? "c" : "n"}${id})`} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round"
            pathLength={100} strokeDasharray={`${p} 100`} />
        )}
        {done && <path d={d} fill="none" stroke={`url(#s${id})`} strokeWidth="6" strokeLinejoin="round" />}
        {/* Внутренний контур — текущий уровень (без уровня — пунктир) */}
        <path d={d} fill="none" transform="translate(50 50) scale(0.78) translate(-50 -50)"
          stroke={tier ? `url(#c${id})` : cur.from} strokeWidth={tier ? 2.5 : 2} strokeDasharray={tier ? undefined : "3 4"} strokeLinejoin="round" />
      </svg>
      <Icon className="relative" style={{ width: size * 0.38, height: size * 0.38, color: cur.ink, opacity: tier ? 1 : 0.75 }} />
    </span>
  );
}
