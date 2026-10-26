"use client";
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  InboxArrowDownIcon,
  LanguageIcon,
  MagnifyingGlassIcon,
  PlayCircleIcon,
  TvIcon,
  ArrowRightStartOnRectangleIcon,
  CalendarDaysIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  Cog6ToothIcon,
  FilmIcon,
  BeakerIcon,
  QueueListIcon,
  MapIcon,
  SparklesIcon,
  Squares2X2Icon,
  SwatchIcon,
  TrophyIcon,
  UserCircleIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, useMe } from "@/lib/client";
import { Avatar } from "./Avatar";
import { HoverCardHost } from "./HoverCard";
import { Notifications } from "./Notifications";
import { SearchBox } from "./SearchBox";
import { cx } from "./ui";

const NAV = [
  { href: "/calendar", label: "Календарь", icon: CalendarDaysIcon },
  { href: "/browse", label: "Каталог", icon: Squares2X2Icon },
  { href: "/lists", label: "Мои списки", icon: QueueListIcon },
  { href: "/friends", label: "Друзья", icon: UsersIcon },
  { href: "/recommendations", label: "Для тебя", icon: SparklesIcon },
  { href: "/graph", label: "Карта", icon: MapIcon },
  { href: "/downloads", label: "Загрузки", icon: ArrowDownTrayIcon },
  { href: "/settings", label: "Настройки", icon: Cog6ToothIcon },
];
// Служебные страницы (превью, лаборатории) — только админу, отдельным блоком меню
export const ADMIN_NAV = [
  { href: "/cards-preview", label: "Варианты карточек", icon: BeakerIcon },
  { href: "/upscale-lab", label: "ИИ-апскейл", icon: SparklesIcon },
  { href: "/achievements-preview", label: "Награды (прототип)", icon: TrophyIcon },
  { href: "/palette", label: "Палитра", icon: SwatchIcon },
  { href: "/profile-preview", label: "Профиль (прототипы)", icon: UserCircleIcon },
];
// Иконки сервисов системы (раздел «Сервисы»)
const SERVICE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  jellyfin: PlayCircleIcon, seerr: InboxArrowDownIcon, sonarr: TvIcon, radarr: FilmIcon, prowlarr: MagnifyingGlassIcon,
  bazarr: LanguageIcon, qbittorrent: ArrowDownTrayIcon, torrserver: BoltIcon,
};

/** «localhost» в адресе сервиса — подставить адрес, с которого открыт календарь (с телефона в домашней сети тоже работает). */
const browserUrl = (url: string) =>
  typeof window !== "undefined" && window.location.hostname !== "localhost" ? url.replace("//localhost", `//${window.location.hostname}`) : url;

// На телефоне внизу помещается пять пунктов; друзья, настройки и загрузки — значками в шапке
const MOBILE_NAV = NAV.filter((n) => !["/settings", "/downloads", "/friends"].includes(n.href));

function Logo({ compact, iconOnly }: { compact?: boolean; iconOnly?: boolean }) {
  return (
    <Link href="/calendar" className="flex shrink-0 items-center gap-2 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-linear-to-br from-indigo-600 to-purple-600 text-lg font-black">
        A
      </span>
      <span className={cx("whitespace-nowrap text-lg font-bold tracking-tight", compact && "hidden sm:inline", iconOnly && "opacity-0", "transition-opacity duration-150")}>Аниме-календарь</span>
    </Link>
  );
}

const SIDEBAR_KEY = "sidebar-collapsed";

/** Подпись пункта: в свёрнутой панели прозрачна (иначе из-под иконки торчат первые буквы), при раскрытии проявляется. */
const Label = ({ hidden, children }: { hidden: boolean; children: React.ReactNode }) => (
  <span className={cx("transition-opacity duration-150", hidden && "opacity-0")}>{children}</span>
);

/**
 * Боковая панель: свёрнута до иконок или развёрнута. Пока не выбрано кнопкой — по ширине экрана
 * (средний экран — свёрнута, широкий — развёрнута); выбор кнопкой запоминается в браузере.
 * Свёрнутая при наведении раскрывается поверх страницы (как вкладки слева в браузере).
 */
function useSidebar() {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [narrowScreen, setNarrowScreen] = useState(false);
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_KEY);
      if (v !== null) setChoice(v === "1");
    } catch { /* без хранилища — по ширине экрана */ }
    const mq = window.matchMedia("(max-width: 1279px)");
    const on = () => setNarrowScreen(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const collapsed = choice ?? narrowScreen;
  const toggle = () => {
    const next = !collapsed;
    setChoice(next);
    setHover(false);
    try { localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* не страшно */ }
  };
  // Раскрытие с небольшой задержкой: мышь, пролетающая мимо края экрана, панель не дёргает
  const enter = () => {
    if (!collapsed) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(true), 150);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(false);
  };
  return { collapsed, narrow: collapsed && !hover, overlay: collapsed && hover, toggle, enter, leave };
}

export function AppShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useMe();
  const bar = useSidebar();
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen">
      {/* Боковая панель (десктоп) */}
      <aside onMouseEnter={bar.enter} onMouseLeave={bar.leave}
        className={cx("fixed inset-y-0 left-0 z-30 hidden flex-col overflow-hidden border-r border-gray-800 backdrop-blur transition-[width] duration-200 md:flex",
          bar.narrow ? "w-16" : "w-64", bar.overlay ? "bg-gray-800/95 shadow-2xl" : "bg-gray-800/60")}>
        <div className="flex h-16 shrink-0 items-center px-1">
          <Logo iconOnly={bar.narrow} />
        </div>
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                title={bar.narrow ? label : undefined}
                className={cx(
                  "flex items-center gap-3 whitespace-nowrap rounded-md px-2.5 py-2.5 text-base font-medium transition",
                  active ? "bg-linear-to-br from-indigo-600 to-purple-600 text-white shadow" : "text-gray-300 hover:bg-gray-700/60 hover:text-white",
                )}
              >
                <Icon className="h-6 w-6 shrink-0" />
                <Label hidden={bar.narrow}>{label}</Label>
              </Link>
            );
          })}
          {me && me.services.length > 0 && (
            <div className="pt-4">
              {bar.narrow ? <div className="mx-2 mb-2 border-t border-gray-700" /> : <p className="whitespace-nowrap px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Сервисы</p>}
              {me.services.map((sv) => {
                const Icon = SERVICE_ICONS[sv.id] ?? ArrowTopRightOnSquareIcon;
                return (
                  <a key={sv.id} href={browserUrl(sv.url)} target="_blank" rel="noreferrer" title={bar.narrow ? sv.name : sv.hint}
                    className="group flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-gray-400 transition hover:bg-gray-700/60 hover:text-white">
                    <Icon className="h-5 w-5 shrink-0" />
                    <Label hidden={bar.narrow}>{sv.name}</Label>
                    <ArrowTopRightOnSquareIcon className="ml-auto h-3.5 w-3.5 opacity-0 transition group-hover:opacity-60" />
                  </a>
                );
              })}
            </div>
          )}
          {me?.isAdmin && (
            <div className="pt-4">
              {bar.narrow ? <div className="mx-2 mb-2 border-t border-gray-700" /> : <p className="whitespace-nowrap px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Для админа</p>}
              {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} title={bar.narrow ? label : undefined}
                  className={cx("flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition",
                    pathname.startsWith(href) ? "bg-gray-700 text-white" : "text-gray-400 hover:bg-gray-700/60 hover:text-white")}>
                  <Icon className="h-5 w-5 shrink-0" />
                  <Label hidden={bar.narrow}>{label}</Label>
                </Link>
              ))}
            </div>
          )}
        </nav>
        <div className="px-3 pb-1">
          <button onClick={bar.toggle} title={bar.collapsed ? "Закрепить панель развёрнутой" : "Свернуть панель до иконок"}
            className="flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-700/60 hover:text-white">
            {bar.collapsed ? <ChevronDoubleRightIcon className="h-5 w-5 shrink-0" /> : <ChevronDoubleLeftIcon className="h-5 w-5 shrink-0" />}
            <Label hidden={bar.narrow}>{bar.collapsed ? "Закрепить" : "Свернуть"}</Label>
          </button>
        </div>
        <div className="border-t border-gray-700/60 px-2 py-3">
          <div className="flex items-center justify-between gap-2 rounded-md px-1 py-2">
            <Link href={me ? `/users/${me.id}` : "#"} title="Мой профиль" className="flex min-w-0 items-center gap-2 rounded-md hover:text-indigo-300">
              {me ? <Avatar user={me} /> : <span className="h-8 w-8 shrink-0 rounded-full bg-gray-700" />}
              <span className={cx("truncate whitespace-nowrap text-sm font-medium transition-opacity duration-150", bar.narrow && "opacity-0")}>{userName}</span>
            </Link>
            {!bar.narrow && (
              <button onClick={logout} title="Выйти" className="rounded p-1.5 text-gray-400 hover:bg-gray-700 hover:text-white">
                <ArrowRightStartOnRectangleIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </aside>

      <div className={cx("transition-[padding] duration-200", bar.collapsed ? "md:pl-16" : "md:pl-64")}>
        {/* Верхняя панель с поиском */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-gray-800 bg-gray-900/85 px-4 backdrop-blur lg:px-8">
          <div className="md:hidden">
            <Logo compact />
          </div>
          <SearchBox />
          <div className="shrink-0 md:ml-auto"><Notifications /></div>
          <Link href="/friends" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Друзья">
            <UsersIcon className="h-6 w-6" />
          </Link>
          <Link href="/downloads" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Загрузки">
            <ArrowDownTrayIcon className="h-6 w-6" />
          </Link>
          <Link href="/settings" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Настройки">
            <Cog6ToothIcon className="h-6 w-6" />
          </Link>
        </header>

        <main className="px-4 pb-24 pt-6 md:pb-10 lg:px-8"><HoverCardHost>{children}</HoverCardHost></main>
      </div>

      {/* Нижняя навигация (мобильные) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gray-800 bg-gray-900/95 backdrop-blur md:hidden">
        {MOBILE_NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}
            className={cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]", pathname.startsWith(href) ? "text-indigo-400" : "text-gray-400")}>
            <Icon className="h-6 w-6" />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
