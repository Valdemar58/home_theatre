"use client";
import { useQuery } from "@tanstack/react-query";
import { achievementDef, describe, eventOrder, GROUP_SHAPE, progressToNext, TIER_NAMES, type AchievementGroup, type AchievementProgress, type Tier } from "@/lib/achievements";
import { api } from "@/lib/client";
import { AchievementBadge, METAL, type BadgeShape } from "./AchievementBadge";
import { Spinner } from "./ui";

// Прототип наград: формы по типам, уровни и прогресс обводкой; правила с порогами и мои реальные значения.

const TIERS: Tier[] = [0, 1, 2, 3, 4];
const SHAPES: [BadgeShape, string, string][] = [
  ["hex", "Грань", "жанры"], ["coin", "Жетон", "привычки зрителя"], ["shield", "Щит", "с друзьями"], ["diamond", "Ромб", "сезонные события"],
];
const GROUPS: [AchievementGroup, string][] = [["event", "Сезонные события"], ["genre", "Жанры (досмотренное)"], ["habit", "Привычки зрителя"], ["social", "С друзьями"]];

export function AchievementCard({ a }: { a: AchievementProgress }) {
  const def = achievementDef(a.id)!;
  const { next, ratio } = progressToNext(a.value, def.thresholds);
  return (
    <div className="flex gap-4 rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700">
      <AchievementBadge icon={def.icon} tier={a.tier} shape={GROUP_SHAPE[def.group]} size={64} progress={ratio} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{def.name}</span>
          {a.tier > 0 && <span className="text-xs font-medium" style={{ color: METAL[a.tier].ink }}>{TIER_NAMES[a.tier]}</span>}
        </div>
        <p className="text-xs text-gray-400">{next ? describe(def, next) : "Высший уровень"}</p>
        {next && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
              <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: `linear-gradient(90deg, ${METAL[(a.tier + 1) as Tier].to}, ${METAL[(a.tier + 1) as Tier].from})` }} />
            </div>
            <span className="text-xs tabular-nums text-gray-400">{a.value} / {next}</span>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          Пороги: {def.thresholds.join(" · ")}
          {a.earnedAt && a.tier > 0 && ` · получено ${new Date(a.earnedAt * 1000).toLocaleDateString("ru-RU")}`}
        </p>
      </div>
    </div>
  );
}

export function AchievementsPreview() {
  const { data, isLoading } = useQuery({ queryKey: ["achievements"], queryFn: () => api<AchievementProgress[]>("/api/achievements") });
  const all = data ?? [];
  const showcase = all.filter((a) => a.tier > 0).sort((a, b) => b.tier - a.tier || b.value - a.value).slice(0, 8);

  return (
    <div className="max-w-6xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Награды — прототип</h1>
        <p className="mt-1 text-sm text-gray-400">
          Форма значка — по типу награды. Внешняя обводка заполняется по мере пути к следующему уровню (его цветом),
          внутренний контур и значок — цвет текущего уровня. Значения — по вашему реальному списку.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Формы и уровни</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {SHAPES.map(([shape, name, use]) => (
            <div key={shape} className="rounded-xl bg-gray-800/50 p-4 ring-1 ring-gray-700">
              <p className="font-semibold">{name} <span className="text-xs font-normal text-gray-400">— {use}</span></p>
              <div className="mt-4 flex items-end justify-between gap-2">
                {TIERS.map((t) => (
                  <div key={t} className="flex flex-col items-center gap-2">
                    <AchievementBadge icon={shape === "diamond" ? "fire" : shape === "shield" ? "users" : shape === "hex" ? "heart" : "clock"}
                      tier={t} shape={shape} size={58} progress={[0.35, 0.6, 0.25, 0.8, 1][t]} />
                    <span className="text-[11px] text-gray-500">{t ? TIER_NAMES[t] : "нет"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Витрина в профиле</h2>
        <div className="flex flex-wrap gap-6 rounded-xl bg-gray-800/40 p-5 ring-1 ring-gray-700">
          {isLoading ? <Spinner /> : showcase.length ? showcase.map((a) => {
            const def = achievementDef(a.id)!;
            return (
              <div key={a.id} className="flex w-24 flex-col items-center gap-2 text-center" title={describe(def, def.thresholds[a.tier - 1])}>
                <AchievementBadge icon={def.icon} tier={a.tier} shape={GROUP_SHAPE[def.group]} size={72} progress={progressToNext(a.value, def.thresholds).ratio} />
                <span className="text-xs leading-tight">{def.name}</span>
              </div>
            );
          }) : <p className="text-sm text-gray-500">Пока без наград</p>}
        </div>
      </section>

      {GROUPS.map(([g, title]) => {
        const items = all.filter((a) => achievementDef(a.id)?.group === g)
          .sort((a, b) => (g === "event" ? eventOrder(b.id) - eventOrder(a.id) : 0));
        if (!items.length) return null;
        return (
          <section key={g}>
            <h2 className="mb-3 text-lg font-semibold">{title}</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((a) => <AchievementCard key={a.id} a={a} />)}</div>
          </section>
        );
      })}
    </div>
  );
}
