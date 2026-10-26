// Режим боковой панели — общий для сервера (читает cookie и сразу рендерит нужную панель) и клиента.

/** По ширине экрана (средний — свёрнута, широкий — развёрнута) или выбранный кнопкой. */
export type SidebarMode = "auto" | "collapsed" | "expanded";
export const SIDEBAR_COOKIE = "sidebar";

export const parseSidebarMode = (v: string | undefined): SidebarMode => (v === "collapsed" || v === "expanded" ? v : "auto");
