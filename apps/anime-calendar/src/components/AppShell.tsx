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
  IdentificationIcon,
  UsersIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, useMe } from "@/lib/client";
import { SIDEBAR_COOKIE, type SidebarMode } from "@/lib/sidebar";
import { Avatar } from "./Avatar";
import { HoverCardHost } from "./HoverCard";
import { ModeProvider, ModeSwitch, sectionHref, sectionOf, useMode, type Section } from "./Mode";
import { Notifications } from "./Notifications";
import { SearchBox } from "./SearchBox";
import { useGroupInvites } from "./SharedListsView";
import { StaleBanner } from "./StaleBanner";
import { cx } from "./ui";

// section — пункт с содержимым по режиму (аниме или книги, TASKS 5.10)
const NAV: { href: string; label: string; icon: typeof CalendarDaysIcon; section?: Section; bookLabel?: string }[] = [
  { href: "/calendar", label: "Календарь", icon: CalendarDaysIcon, section: "calendar", bookLabel: "Выход глав" },
  { href: "/browse", label: "Каталог", icon: Squares2X2Icon, section: "catalog" },
  { href: "/lists", label: "Мои списки", icon: QueueListIcon, section: "lists" },
  { href: "/friends", label: "Друзья", icon: UsersIcon },
  { href: "/groups", label: "Группы", icon: UserGroupIcon },
  { href: "/recommendations", label: "Для тебя", icon: SparklesIcon },
  { href: "/graph", label: "Карта", icon: MapIcon },
  { href: "/downloads", label: "Загрузки", icon: ArrowDownTrayIcon },
  { href: "/settings", label: "Настройки", icon: Cog6ToothIcon },
];
// Служебные страницы (превью, лаборатории) — только админу, отдельным блоком меню
export const ADMIN_NAV = [
  { href: "/accounts", label: "Пользователи", icon: IdentificationIcon },
  { href: "/import/animego", label: "Импорт AnimeGo", icon: InboxArrowDownIcon },
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

/** Пункты меню в режиме: разделы книг — свои адреса и подписи; active — пункт текущей страницы. */
function useNav(pathname: string) {
  const mode = useMode(true) ?? "anime";
  const section = sectionOf(pathname);
  return (items: typeof NAV) => items.map((n) => {
    const href = n.section ? sectionHref(n.section, mode) : n.href;
    const label = n.section && mode !== "anime" ? n.bookLabel ?? n.label : n.label;
    const active = n.section ? section === n.section : pathname.startsWith(n.href);
    return { ...n, href, label, active };
  });
}

function Logo({ compact, textClass }: { compact?: boolean; textClass?: string }) {
  return (
    <Link href="/calendar" className="flex shrink-0 items-center gap-2 px-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-linear-to-br from-indigo-600 to-purple-600 text-lg font-black">
        A
      </span>
      <span className={cx("whitespace-nowrap text-lg font-bold tracking-tight", compact && "hidden sm:inline", textClass, "transition-opacity duration-150")}>Аниме-календарь</span>
    </Link>
  );
}

/**
 * Боковая панель. Выбор кнопкой хранится в cookie — сервер сразу отдаёт страницу с нужной панелью;
 * режим «по ширине» задан только классами (xl:), поэтому первая отрисовка тоже без мигания.
 * Свёрнутая при наведении раскрывается поверх страницы (как вкладки слева в браузере).
 */
function useSidebar(initial: SidebarMode) {
  const [mode, setMode] = useState<SidebarMode>(initial);
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapsedNow = () => mode === "collapsed" || (mode === "auto" && !window.matchMedia("(min-width: 1280px)").matches);
  const toggle = () => {
    const next: SidebarMode = collapsedNow() ? "expanded" : "collapsed";
    setMode(next);
    setHover(false);
    document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  };
  // Раскрытие с небольшой задержкой: мышь, пролетающая мимо края экрана, панель не дёргает
  const enter = () => {
    if (!collapsedNow()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(true), 150);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(false);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const pick = (collapsed: string, auto: string, expanded: string) => (mode === "collapsed" ? collapsed : mode === "auto" ? auto : expanded);
  return {
    mode, toggle, enter, leave, overlay: hover,
    width: hover ? "w-64" : pick("w-16", "w-16 xl:w-64", "w-64"),
    pad: pick("md:pl-16", "md:pl-16 xl:pl-64", "md:pl-64"),
    // Подписи в свёрнутой панели прозрачны (иначе из-под иконок торчат первые буквы); линия вместо заголовка раздела — наоборот
    label: hover ? "" : pick("opacity-0", "opacity-0 xl:opacity-100", ""),
    rule: hover ? "opacity-0" : pick("", "xl:opacity-0", "opacity-0"),
    title: (s: string) => (mode === "expanded" ? undefined : s),
  };
}

/** Подпись пункта панели: прозрачность — по состоянию панели (классы из useSidebar). */
const Label = ({ cls, children }: { cls: string; children: React.ReactNode }) => (
  <span className={cx("transition-opacity duration-150", cls)}>{children}</span>
);

/** Заголовок раздела; в свёрнутой панели — линия на том же месте и той же высоты (иконки ниже не прыгают). */
function Section({ bar, children }: { bar: { label: string; rule: string }; children: React.ReactNode }) {
  return (
    <div className="relative h-6">
      <p className={cx("absolute inset-x-0 top-0 whitespace-nowrap px-3 text-xs font-semibold uppercase leading-6 tracking-wider text-gray-500 transition-opacity duration-150", bar.label)}>{children}</p>
      <div className={cx("absolute inset-x-2 top-1/2 border-t border-gray-700 transition-opacity duration-150", bar.rule)} />
    </div>
  );
}

type ShellProps = { userName: string; sidebar?: SidebarMode; children: React.ReactNode };

export function AppShell(props: ShellProps) {
  return <ModeProvider><Shell {...props} /></ModeProvider>;
}

function Shell({ userName, sidebar = "auto", children }: ShellProps) {
  const pathname = usePathname();
  const nav = useNav(pathname);
  const { data: me } = useMe();
  const bar = useSidebar(sidebar);
  // Приглашения в группы — значком у пункта меню
  const groupInvites = useGroupInvites();
  const logout = async () => {
    const res = await api<{ redirect: string | null }>("/api/auth/logout", { method: "POST" });
    window.location.href = res.redirect ?? "/login";
  };

  return (
    <div className="min-h-screen">
      {/* Боковая панель (десктоп) */}
      <aside onMouseEnter={bar.enter} onMouseLeave={bar.leave}
        className={cx("fixed inset-y-0 left-0 z-30 hidden flex-col overflow-hidden border-r border-gray-800 backdrop-blur transition-[width] duration-200 md:flex",
          bar.width, bar.overlay ? "bg-gray-800/95 shadow-2xl" : "bg-gray-800/60")}>
        <div className="flex h-16 shrink-0 items-center px-1">
          <Logo textClass={bar.label} />
        </div>
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-3">
          {nav(NAV.filter((n) => me?.isAdmin || n.href !== "/downloads")).map(({ href, label, icon: Icon, active }) => {
            return (
              <Link
                key={href}
                href={href}
                title={bar.title(label)}
                className={cx(
                  "flex items-center gap-3 whitespace-nowrap rounded-md px-2.5 py-2.5 text-base font-medium transition",
                  active ? "bg-linear-to-br from-indigo-600 to-purple-600 text-white shadow" : "text-gray-300 hover:bg-gray-700/60 hover:text-white",
                )}
              >
                <span className="relative shrink-0">
                  <Icon className="h-6 w-6" />
                  {href === "/groups" && groupInvites > 0 && (
                    <span className="absolute -right-1.5 -top-1 rounded-full bg-indigo-500 px-1 text-[10px] font-semibold leading-4 text-white">{groupInvites}</span>
                  )}
                </span>
                <Label cls={bar.label}>{label}</Label>
              </Link>
            );
          })}
          {me && me.services.length > 0 && (
            <div className="pt-4">
              <Section bar={bar}>Сервисы</Section>
              {me.services.map((sv) => {
                const Icon = SERVICE_ICONS[sv.id] ?? ArrowTopRightOnSquareIcon;
                return (
                  <a key={sv.id} href={browserUrl(sv.url)} target="_blank" rel="noreferrer" title={bar.mode === "expanded" ? sv.hint : sv.name}
                    className="group flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-gray-400 transition hover:bg-gray-700/60 hover:text-white">
                    <Icon className="h-5 w-5 shrink-0" />
                    <Label cls={bar.label}>{sv.name}</Label>
                    <ArrowTopRightOnSquareIcon className="ml-auto h-3.5 w-3.5 opacity-0 transition group-hover:opacity-60" />
                  </a>
                );
              })}
            </div>
          )}
          {me?.isAdmin && (
            <div className="pt-4">
              <Section bar={bar}>Для админа</Section>
              {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} title={bar.title(label)}
                  className={cx("flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition",
                    pathname.startsWith(href) ? "bg-gray-700 text-white" : "text-gray-400 hover:bg-gray-700/60 hover:text-white")}>
                  <Icon className="h-5 w-5 shrink-0" />
                  <Label cls={bar.label}>{label}</Label>
                </Link>
              ))}
            </div>
          )}
        </nav>
        <div className="px-3 pb-1">
          <button onClick={bar.toggle} title={bar.mode === "expanded" ? "Свернуть панель до иконок" : "Закрепить панель развёрнутой"}
            className="flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-700/60 hover:text-white">
            {/* «По ширине»: на широком экране панель развёрнута — кнопка сворачивает */}
            <ChevronDoubleRightIcon className={cx("h-5 w-5 shrink-0", bar.mode === "expanded" && "hidden", bar.mode === "auto" && "xl:hidden")} />
            <ChevronDoubleLeftIcon className={cx("h-5 w-5 shrink-0", bar.mode === "collapsed" && "hidden", bar.mode === "auto" && "hidden xl:block")} />
            <Label cls={bar.label}>
              <span className={cx(bar.mode === "expanded" && "hidden", bar.mode === "auto" && "xl:hidden")}>Закрепить</span>
              <span className={cx(bar.mode === "collapsed" && "hidden", bar.mode === "auto" && "hidden xl:inline")}>Свернуть</span>
            </Label>
          </button>
        </div>
        <div className="border-t border-gray-700/60 px-2 py-3">
          {/* Ширина постоянная: при сворачивании ничего не переносится, правое просто уходит за край */}
          <div className="flex w-60 items-center justify-between gap-2 rounded-md px-1 py-2">
            <Link href={me ? `/users/${me.id}` : "#"} title="Мой профиль" className="flex min-w-0 items-center gap-2 rounded-md hover:text-indigo-300">
              {me ? <Avatar user={me} /> : <span className="h-8 w-8 shrink-0 rounded-full bg-gray-700" />}
              <span className={cx("truncate whitespace-nowrap text-sm font-medium transition-opacity duration-150", bar.label)}>{userName}</span>
            </Link>
            <button onClick={logout} title="Выйти" className={cx("rounded p-1.5 text-gray-400 transition-opacity hover:bg-gray-700 hover:text-white", bar.label)}>
              <ArrowRightStartOnRectangleIcon className="h-5 w-5" />
            </button>
          </div>
        </div>
      </aside>

      <div className={cx("transition-[padding] duration-200", bar.pad)}>
        {/* Верхняя панель с поиском */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-1.5 border-b md:gap-3 border-gray-800 bg-gray-900/85 px-4 backdrop-blur lg:px-8">
          <div className="md:hidden">
            <Logo compact />
          </div>
          <ModeSwitch className="hidden md:flex" />
          <SearchBox />
          <div className="shrink-0 md:ml-auto"><Notifications /></div>
          <Link href="/friends" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Друзья">
            <UsersIcon className="h-6 w-6" />
          </Link>
          {me?.isAdmin && (
            <Link href="/downloads" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Загрузки">
              <ArrowDownTrayIcon className="h-6 w-6" />
            </Link>
          )}
          <Link href="/settings" className="rounded-md p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden" aria-label="Настройки">
            <Cog6ToothIcon className="h-6 w-6" />
          </Link>
        </header>

        {/* На телефоне режимы — отдельной строкой под шапкой */}
        <div className="px-4 pt-3 md:hidden"><ModeSwitch wide /></div>
        <main className="px-4 pb-24 pt-4 md:pb-10 md:pt-6 lg:px-8"><StaleBanner /><HoverCardHost>{children}</HoverCardHost></main>
      </div>

      {/* Нижняя навигация (мобильные) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gray-800 bg-gray-900/95 backdrop-blur md:hidden">
        {nav(MOBILE_NAV).map(({ href, label, icon: Icon, active }) => (
          <Link key={href} href={href}
            className={cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]", active ? "text-indigo-400" : "text-gray-400")}>
            <Icon className="h-6 w-6" />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
