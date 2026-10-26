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

function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link href="/calendar" className="flex shrink-0 items-center gap-2 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-linear-to-br from-indigo-600 to-purple-600 text-lg font-black">
        A
      </span>
      <span className={cx("whitespace-nowrap text-lg font-bold tracking-tight", compact && "hidden sm:inline")}>Аниме-календарь</span>
    </Link>
  );
}

export function AppShell({ userName, children }: { userName: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useMe();
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen">
      {/* Боковая панель (десктоп) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-gray-800 bg-gray-800/60 backdrop-blur lg:flex">
        <div className="flex h-16 items-center">
          <Logo />
        </div>
        <nav className="mt-4 flex-1 space-y-1 px-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cx(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-base font-medium transition",
                  active ? "bg-linear-to-br from-indigo-600 to-purple-600 text-white shadow" : "text-gray-300 hover:bg-gray-700/60 hover:text-white",
                )}
              >
                <Icon className="h-6 w-6" />
                {label}
              </Link>
            );
          })}
          {me && me.services.length > 0 && (
            <div className="pt-4">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Сервисы</p>
              {me.services.map((sv) => {
                const Icon = SERVICE_ICONS[sv.id] ?? ArrowTopRightOnSquareIcon;
                return (
                  <a key={sv.id} href={browserUrl(sv.url)} target="_blank" rel="noreferrer" title={sv.hint}
                    className="group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-gray-400 transition hover:bg-gray-700/60 hover:text-white">
                    <Icon className="h-5 w-5" />
                    {sv.name}
                    <ArrowTopRightOnSquareIcon className="ml-auto h-3.5 w-3.5 opacity-0 transition group-hover:opacity-60" />
                  </a>
                );
              })}
            </div>
          )}
          {me?.isAdmin && (
            <div className="pt-4">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-500">Для админа</p>
              {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href}
                  className={cx("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition",
                    pathname.startsWith(href) ? "bg-gray-700 text-white" : "text-gray-400 hover:bg-gray-700/60 hover:text-white")}>
                  <Icon className="h-5 w-5" />
                  {label}
                </Link>
              ))}
            </div>
          )}
        </nav>
        <div className="border-t border-gray-700/60 p-3">
          <div className="flex items-center justify-between rounded-md px-2 py-2">
            <Link href={me ? `/users/${me.id}` : "#"} title="Мой профиль" className="flex min-w-0 items-center gap-2 rounded-md hover:text-indigo-300">
              {me ? <Avatar user={me} /> : <span className="h-8 w-8 rounded-full bg-gray-700" />}
              <span className="truncate text-sm font-medium">{userName}</span>
            </Link>
            <button onClick={logout} title="Выйти" className="rounded p-1.5 text-gray-400 hover:bg-gray-700 hover:text-white">
              <ArrowRightStartOnRectangleIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        {/* Верхняя панель с поиском */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-gray-800 bg-gray-900/85 px-4 backdrop-blur lg:px-8">
          <div className="lg:hidden">
            <Logo compact />
          </div>
          <SearchBox />
          <div className="shrink-0 lg:ml-auto"><Notifications /></div>
          <Link href="/friends" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white lg:hidden" aria-label="Друзья">
            <UsersIcon className="h-6 w-6" />
          </Link>
          <Link href="/downloads" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white lg:hidden" aria-label="Загрузки">
            <ArrowDownTrayIcon className="h-6 w-6" />
          </Link>
          <Link href="/settings" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white lg:hidden" aria-label="Настройки">
            <Cog6ToothIcon className="h-6 w-6" />
          </Link>
        </header>

        <main className="px-4 pb-24 pt-6 lg:px-8 lg:pb-10"><HoverCardHost>{children}</HoverCardHost></main>
      </div>

      {/* Нижняя навигация (мобильные) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gray-800 bg-gray-900/95 backdrop-blur lg:hidden">
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
