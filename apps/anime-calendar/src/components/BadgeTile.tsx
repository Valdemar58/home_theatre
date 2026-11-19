"use client";
import { achievementDef, describe, GROUP_SHAPE, progressToNext, TIER_NAMES, type AchievementProgress, type Tier } from "@/lib/achievements";
import { achievementXp } from "@/lib/profile-rpg";
import { AchievementBadge, METAL } from "./AchievementBadge";
import { cx } from "./ui";

// Значок награды с подписью и подробной подсказкой при наведении: уровень, что дальше, прогресс,
// опыт с этой награды, пороги всех уровней и дата получения.

const GROUP_LABEL = { genre: "Жанры", habit: "Привычки зрителя", social: "С друзьями", event: "Сезонное событие" } as const;

export function BadgeTile({ a, hours, size = 56, label = true, className }: {
  a: AchievementProgress; hours: number; size?: number; label?: boolean; className?: string;
}) {
  const def = achievementDef(a.id);
  if (!def) return null;
  const { next, ratio } = progressToNext(a.value, def.thresholds);
  const xp = achievementXp(a, hours);
  return (
    <div className={cx("group relative flex w-20 flex-col items-center gap-1.5 text-center", className)}>
      <span className="transition duration-200 group-hover:-translate-y-0.5 group-hover:drop-shadow-[0_6px_14px_rgba(0,0,0,0.5)]">
        <AchievementBadge icon={def.icon} tier={a.tier} shape={GROUP_SHAPE[def.group]} size={size} progress={ratio} />
      </span>
      {label && <span className="text-[11px] leading-tight text-gray-300">{def.name}</span>}

      <div className="mobile-tooltip pointer-events-none invisible absolute left-1/2 top-full z-30 mt-2 w-64 md:-translate-x-1/2 md:translate-y-1 rounded-xl bg-gray-900/97 p-3 text-left opacity-0 shadow-2xl ring-1 ring-gray-700 transition duration-150 group-hover:visible md:group-hover:translate-y-0 group-hover:opacity-100">
        <p className="text-[10px] uppercase tracking-wider text-gray-500">{GROUP_LABEL[def.group]}</p>
        <p className="font-semibold">{def.name}
          <span className="ml-1.5 text-xs font-medium" style={{ color: METAL[a.tier].ink }}>{a.tier ? TIER_NAMES[a.tier] : "не получена"}</span>
        </p>
        <p className="mt-1 text-xs text-gray-300">{next ? `Дальше: ${describe(def, next)}` : `${describe(def, def.thresholds[3])} — высший уровень`}</p>
        {next && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
              <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: `linear-gradient(90deg, ${METAL[(a.tier + 1) as Tier].to}, ${METAL[(a.tier + 1) as Tier].from})` }} />
            </div>
            <span className="text-[11px] tabular-nums text-gray-400">{a.value} / {next}</span>
          </div>
        )}
        <div className="mt-2 flex gap-1">
          {def.thresholds.map((t, i) => (
            <span key={i} className={cx("flex-1 rounded px-1 py-0.5 text-center text-[10px] tabular-nums", a.tier > i ? "text-gray-900" : "bg-gray-800 text-gray-500")}
              style={a.tier > i ? { background: `linear-gradient(135deg, ${METAL[(i + 1) as Tier].from}, ${METAL[(i + 1) as Tier].to})` } : undefined}>
              {t}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-gray-400">
          Опыт: <b className="text-warning-200">{xp}</b>{a.id === "hours" && " — 10 за каждый час, растёт и после платины"}
          {a.earnedAt && a.tier > 0 && <span className="text-gray-500"> · получено {new Date(a.earnedAt * 1000).toLocaleDateString("ru-RU")}</span>}
        </p>
      </div>
    </div>
  );
}
