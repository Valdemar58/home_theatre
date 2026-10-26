"use client";
import {
  BoltIcon, ChatBubbleLeftRightIcon, EnvelopeIcon, EnvelopeOpenIcon, ExclamationTriangleIcon, FlagIcon, InformationCircleIcon,
  PlayIcon, QueueListIcon, SpeakerWaveIcon, TrophyIcon, UserPlusIcon, UsersIcon, XMarkIcon,
} from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useNoticeActions } from "@/lib/client";
import { kindInfo, type NoticeIcon } from "@/lib/notice-kinds";
import { ago } from "@/lib/time";
import type { Notice, NoticeAction } from "@/lib/types";
import { achievementDef, GROUP_SHAPE, type Tier } from "@/lib/achievements";
import { AchievementBadge } from "./AchievementBadge";
import { Avatar } from "./Avatar";
import { Img } from "./Img";
import { TONE_CLASS, cx } from "./ui";

// Карточка уведомления: слева обложка тайтла / аватар / значок вида; справа — метка вида цветом и время,
// тайтл или автор отдельной строкой, короткий текст. Новые выделены. Прочитать / удалить — при наведении,
// действия (принять заявку, отменить отметку) — прямо в карточке.

const ICONS: Record<NoticeIcon, React.ComponentType<{ className?: string }>> = {
  play: PlayIcon, flag: FlagIcon, speaker: SpeakerWaveIcon, bolt: BoltIcon, user: UserPlusIcon, list: QueueListIcon,
  users: UsersIcon, chat: ChatBubbleLeftRightIcon, alert: ExclamationTriangleIcon, info: InformationCircleIcon, trophy: TrophyIcon,
};


/** Маленькая кнопка действия внутри уведомления — не раздувает высоту карточки. */
function Mini({ primary, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...props} className={cx("inline-flex h-6 items-center rounded-md px-2 text-xs font-medium transition disabled:opacity-60",
    primary ? "tone-accent solid" : "tone-neutral soft", className)} />;
}

function ActionButtons({ actions, onDone }: { actions: NoticeAction[]; onDone: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, keys: string[][]) => {
    setBusy(true);
    try {
      await fn();
      for (const k of keys) void qc.invalidateQueries({ queryKey: k });
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      {actions.map((a, i) => {
        if (a.type === "friend") return (
          <span key={i} className="flex gap-1.5">
            <Mini primary disabled={busy} onClick={() => run(() => api("/api/friends", { method: "POST", json: { userId: a.userId, action: "accept" } }), [["people"], ["notices"]])}>Принять</Mini>
            <Mini disabled={busy} onClick={() => run(() => api("/api/friends", { method: "POST", json: { userId: a.userId, action: "decline" } }), [["people"], ["notices"]])}>Отклонить</Mini>
          </span>
        );
        if (a.type === "shared-invite") return (
          <span key={i} className="flex gap-1.5">
            <Mini primary disabled={busy} onClick={() => run(() => api(`/api/shared-lists/${a.listId}`, { method: "POST", json: { action: "accept" } }), [["shared-lists"], ["notices"]])}>Присоединиться</Mini>
            <Mini disabled={busy} onClick={() => run(() => api(`/api/shared-lists/${a.listId}`, { method: "POST", json: { action: "decline" } }), [["shared-lists"], ["notices"]])}>Отклонить</Mini>
          </span>
        );
        if (a.type === "undo") return (
          <Mini key={i} disabled={busy} onClick={() => run(() => api(`/api/together/${a.eventId}`, { method: "POST" }), [["list"], ["notices"]])}>Отменить отметку</Mini>
        );
        return <Mini key={i} primary onClick={() => { onDone(); router.push(a.href); }}>{a.label}</Mini>;
      })}
    </span>
  );
}

export function NoticeItem({ n, onNavigate, toast }: { n: Notice; onNavigate?: () => void; toast?: boolean }) {
  const router = useRouter();
  const act = useNoticeActions();
  const info = kindInfo(n.kind, n.error);
  const tone = TONE_CLASS[info.tone];
  const Icon = ICONS[info.icon];
  const subject = n.media?.title ?? n.actor?.name ?? n.subject;
  const open = () => {
    if (!n.read) void act.read([n.id]);
    onNavigate?.();
    if (n.href) router.push(n.href);
  };

  return (
    <div role={n.href ? "link" : undefined} onClick={n.href ? open : undefined}
      className={cx("group relative flex gap-3 px-4 py-3 transition", n.href && "cursor-pointer hover:bg-gray-700/40", !n.read && !toast && "bg-accent-500/7")}>
      {/* Слева: значок награды, обложка (с аватаром автора), аватар или значок вида */}
      {n.achievement && achievementDef(n.achievement.id) ? (
        <AchievementBadge icon={achievementDef(n.achievement.id)!.icon} tier={n.achievement.tier as Tier}
          shape={GROUP_SHAPE[achievementDef(n.achievement.id)!.group]} size={toast ? 56 : 48} progress={1} />
      ) : n.media ? (
        <div className="relative h-21 w-14 shrink-0">
          <div className="relative h-full w-full overflow-hidden rounded-md ring-1 ring-gray-700" style={{ backgroundColor: n.media.color ?? "#1f2937" }}>
            {n.media.cover && <Img src={n.media.cover} size="thumb" className="absolute inset-0 h-full w-full object-cover" />}
          </div>
          {n.actor && <span className="absolute -bottom-1.5 -right-1.5 flex rounded-full ring-2 ring-gray-800"><Avatar user={n.actor} className="h-6 w-6 text-[10px]" /></span>}
        </div>
      ) : n.actor ? (
        <Avatar user={n.actor} className="h-11 w-11 text-base" />
      ) : (
        <span className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-full soft", tone)}><Icon className="h-5 w-5" /></span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 pr-14 text-[11px]">
          {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-accent-400" aria-label="Новое" />}
          <span className={cx("inline-flex items-center gap-1 font-medium tone-text", tone)}><Icon className="h-3.5 w-3.5" />{info.label}</span>
          <span className="text-gray-500" title={new Date(n.createdAt * 1000).toLocaleString("ru-RU")}>· {ago(n.createdAt)}</span>
        </div>
        {subject && <p className={cx("mt-0.5 truncate text-sm", n.read ? "font-medium text-gray-200" : "font-semibold text-white")}>{subject}</p>}
        <p className={cx("text-sm leading-snug", subject ? "text-gray-300" : "font-semibold text-white", "line-clamp-2")}>{n.title}</p>
        {/* Подробности и действия — одной строкой (кнопки маленькие и не добавляют высоты) */}
        {(n.body || n.actions.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {n.body && <p className={cx("min-w-0 flex-1 basis-40 text-xs text-gray-400", n.actions.length ? "line-clamp-1" : "line-clamp-2")}>{n.body}</p>}
            {n.actions.length > 0 && <ActionButtons actions={n.actions} onDone={() => { if (!n.read) void act.read([n.id]); onNavigate?.(); }} />}
          </div>
        )}
      </div>

      {!toast && (
        <div className="absolute right-2 top-2 flex gap-0.5 transition sm:opacity-0 sm:group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (n.read ? act.unread([n.id]) : act.read([n.id]))} title={n.read ? "Отметить непрочитанным" : "Отметить прочитанным"}
            className="rounded p-1 text-gray-500 hover:bg-gray-600 hover:text-white">
            {n.read ? <EnvelopeIcon className="h-4 w-4" /> : <EnvelopeOpenIcon className="h-4 w-4" />}
          </button>
          <button onClick={() => act.remove([n.id])} title="Удалить" className="rounded p-1 text-gray-500 hover:bg-gray-600 hover:text-white">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
