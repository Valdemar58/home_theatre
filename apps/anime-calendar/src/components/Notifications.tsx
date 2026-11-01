"use client";
import { BellIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNoticeActions, useNotices, useNoticeTab } from "@/lib/client";
import { NOTICE_GROUPS } from "@/lib/notice-kinds";
import type { Notice, NoticeCounts } from "@/lib/types";
import { NoticeItem } from "./NoticeItem";
import { Skel, cx } from "./ui";

// Колокольчик в шапке: компактное окно с вкладками «Все / Тайтлы / Друзья / Важное» (последние 8),
// «Прочитать все», ссылка на страницу со всей историей. Новые (пришедшие, пока вкладка открыта) — тостом.
// Итоги фоновых задач обновляют связанные данные на открытых страницах.

const TOAST_MS = 8000;

/** Вкладки со счётчиками непрочитанного. */
export function NoticeTabs({ value, onChange, unread }: { value: string; onChange: (g: string) => void; unread?: NoticeCounts }) {
  return (
    <div className="flex gap-1 overflow-x-auto">
      {NOTICE_GROUPS.map(([g, label]) => {
        const n = unread?.[g] ?? 0;
        return (
          <button key={g} onClick={() => onChange(g)}
            className={cx("inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition",
              value === g ? "bg-gray-100 text-gray-900" : "text-gray-300 hover:bg-gray-700")}>
            {label}
            {n > 0 && <span className={cx("rounded-full px-1.5 text-[10px] font-bold", "tone-accent solid")}>{n > 99 ? "99+" : n}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function NoticeList({ items, empty, onNavigate }: { items: Notice[]; empty: string; onNavigate?: () => void }) {
  if (!items.length) return <p className="px-4 py-10 text-center text-sm text-gray-400">{empty}</p>;
  return <div className="divide-y divide-gray-700/60">{items.map((n) => <NoticeItem key={n.id} n={n} onNavigate={onNavigate} />)}</div>;
}

/** Уведомления-заглушки той же формы: обложка, строка вида и времени, две строки текста. */
export function NoticeListSkeleton({ count }: { count: number }) {
  return (
    <div aria-busy className="divide-y divide-gray-700/60">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-3 px-4 py-3">
          <Skel className="h-21 w-14 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5"><Skel className="h-3 w-32" /><Skel className="h-4 w-3/4" /><Skel className="h-4 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

export const EMPTY: Record<string, string> = {
  all: "Пока пусто. Здесь будут новые серии, найденные озвучки, заявки друзей и ответы.",
  titles: "О тайтлах пока ничего: новые серии из «Смотрю», финалы из «Жду выхода», озвучки.",
  friends: "От друзей пока ничего.",
  achievements: "Новых наград пока нет — они приходят сюда, когда награда получает новый уровень.",
  important: "Ничего важного — ошибок и системных сообщений нет.",
};

export function Notifications() {
  const qc = useQueryClient();
  const { data } = useNotices();
  const act = useNoticeActions();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("all");
  const { data: page, isLoading } = useNoticeTab(tab, open);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const lastId = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Портал — только после гидратации (на сервере document нет)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Новые с прошлого опроса → тост; при первой загрузке старые не всплывают
  useEffect(() => {
    if (!data) return;
    const max = Math.max(0, ...data.items.map((n) => n.id));
    if (lastId.current === null) { lastId.current = max; return; }
    const fresh = data.items.filter((n) => n.id > lastId.current! && !n.read);
    lastId.current = Math.max(lastId.current, max);
    if (!fresh.length) return;
    setToasts((t) => [...fresh, ...t].slice(0, 3));
    // Окно открыто — показать новое и там
    void qc.invalidateQueries({ queryKey: ["notices", "tab"] });
    // Озвучки готовы — открытые страницы покажут их без перезагрузки
    if (fresh.some((n) => n.kind === "voices")) void qc.invalidateQueries({ queryKey: ["voices"] });
    // Новый уровень награды — профиль и опыт обновятся
    if (fresh.some((n) => n.kind === "achievement")) void qc.invalidateQueries({ queryKey: ["profile-stats"] });
  }, [data, qc]);

  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((all) => all.slice(0, -1)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const unread = data?.unread;
  const total = unread?.all ?? 0;
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <>
      <div ref={box} className="relative">
        <button onClick={() => setOpen(!open)}
          className="relative rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Уведомления">
          <BellIcon className="h-6 w-6" />
          {total > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-500 px-1 text-[10px] font-bold text-white">
              {total > 9 ? "9+" : total}
            </span>
          )}
        </button>
        {open && (
          <div className="fixed inset-x-2 top-[calc(6.5rem+env(safe-area-inset-top))] z-40 flex max-h-[calc(100dvh-12rem)] flex-col overflow-hidden rounded-xl bg-gray-800 shadow-2xl ring-1 ring-gray-700 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[calc(100dvh-5rem)] sm:w-104">
            <div className="flex items-center gap-2 px-4 pb-2 pt-3">
              <p className="mr-auto text-sm font-semibold">Уведомления</p>
              <button onClick={() => act.read(undefined, tab)} disabled={!(unread?.[tab as keyof NoticeCounts] ?? 0)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent-300 hover:bg-gray-700 disabled:text-gray-600 disabled:hover:bg-transparent">
                <CheckIcon className="h-3.5 w-3.5" />Прочитать все
              </button>
            </div>
            <div className="border-b border-gray-700 px-3 pb-2"><NoticeTabs value={tab} onChange={setTab} unread={unread} /></div>
            <div className="min-h-0 flex-1 overflow-y-auto sm:max-h-112">
              {isLoading || !page ? <NoticeListSkeleton count={4} />
                : <NoticeList items={page.items} empty={EMPTY[tab]} onNavigate={() => setOpen(false)} />}
            </div>
            <Link href={`/notifications${tab === "all" ? "" : `?tab=${tab}`}`} onClick={() => setOpen(false)}
              className="border-t border-gray-700 px-4 py-2.5 text-center text-sm text-accent-300 hover:bg-gray-700/50">
              Все уведомления →
            </Link>
          </div>
        )}
      </div>

      {/* Тосты: через портал — у шапки backdrop-blur, и fixed внутри неё считался бы от шапки, а не от окна */}
      {mounted && createPortal(
        <div className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-88 max-w-[calc(100vw-2rem)] flex-col gap-2 lg:bottom-6">
          {toasts.map((n) => (
            <div key={n.id} className={cx("pointer-events-auto relative overflow-hidden rounded-xl bg-gray-800/95 shadow-2xl backdrop-blur",
              n.achievement ? "toast-achievement ring-1 ring-warning-400/60" : "ring-1 ring-accent-500/40")}>
              {n.achievement && <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-warning-500/15 via-transparent to-transparent" />}
              <NoticeItem n={n} toast onNavigate={() => dismiss(n.id)} />
              <button onClick={() => dismiss(n.id)} className="absolute right-2 top-2 rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white" aria-label="Скрыть">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>, document.body)}
    </>
  );
}
