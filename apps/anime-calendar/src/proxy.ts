import { NextRequest, NextResponse } from "next/server";
import { maintenanceActive, maintenanceProgressAllowed, MAINTENANCE_MESSAGE } from "./server/maintenance";
import { unsupportedDesktop } from "./desktop-contract";

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (pathname.startsWith("/api/") && pathname !== "/api/desktop/info" && unsupportedDesktop(req.headers))
    return NextResponse.json({ error: "Протокол desktop несовместим с сервером. Проверьте обновления приложения и сервера.", code: "DESKTOP_INCOMPATIBLE" }, { status: 426, headers: { "Cache-Control": "no-store" } });
  // Existing SSE streams carry the coordinated pause. No new work is admitted.
  const readOnly = req.method === "GET" && (pathname === "/api/maintenance" || pathname === "/api/me" ||
    pathname.startsWith("/api/health/") || /^\/api\/rooms\/[A-Za-z0-9_-]{1,128}(?:\/events)?$/.test(pathname));
  if (maintenanceActive() && !readOnly && !maintenanceProgressAllowed(req.method, pathname) && pathname !== "/maintenance") {
    if (!pathname.startsWith("/api/")) return NextResponse.rewrite(new URL("/maintenance", req.url), { status: 503 });
    return NextResponse.json({ error: MAINTENANCE_MESSAGE, maintenance: true },
      { status: 503, headers: { "Retry-After": "15", "Cache-Control": "no-store" } });
  }
  return NextResponse.next();
}
export const config = { matcher: "/((?!_next/|favicon.ico|desktop-stream-sw.js).*)" };
