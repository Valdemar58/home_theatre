import "server-only";
import { NextResponse } from "next/server";
import { HttpError } from "./http";
import { currentUser, type User } from "./session";
import { SourceDown, withServedLog } from "./sources";
import { beginMaintenanceWork, maintenanceActive, maintenanceProgressAllowed, MAINTENANCE_MESSAGE } from "./maintenance";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });

type Ctx<P> = { params: Promise<P> };

/**
 * Обёртка маршрута: проверка входа и единый формат ошибок. Данные, отданные из сохранённого (источник недоступен),
 * отмечаются заголовком X-Data-Stale: «anilist=<секунды>,shikimori=…» — клиент показывает плашку.
 */
export function authed<P = Record<string, string>>(
  handler: (req: Request, user: User, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      const user = await currentUser();
      if (!user) return json({ error: "Нужно войти" }, 401);
      const readOnlyRoom = req.method === "GET" && /^\/api\/rooms\/[a-f0-9]+(?:\/events)?$/.test(new URL(req.url).pathname);
      if (maintenanceActive() && !maintenanceProgressAllowed(req.method, new URL(req.url).pathname) && !readOnlyRoom && new URL(req.url).pathname !== "/api/me")
        return json({ error: MAINTENANCE_MESSAGE, maintenance: true }, 503);
      const finish = beginMaintenanceWork("request");
      try {
      const { value: res, served } = await withServedLog(async () =>
        handler(req, user, await ctx.params),
      );
      if (served.size)
        res.headers.set(
          "X-Data-Stale",
          [...served].map(([s, t]) => `${s}=${t}`).join(","),
        );
      return res;
      } finally { finish(); }
    } catch (err) {
      if (err instanceof ApiError)
        return json({ error: err.message }, err.status);
      // Источник лежит, а сохранённого нет — честно об этом, без трассировки в логе
      if (err instanceof SourceDown)
        return json(
          {
            error: `${err.message}, а этих данных нет в сохранённом`,
            source: err.source,
          },
          503,
        );
      console.error(err);
      const status = err instanceof HttpError && err.status === 404 ? 404 : 502;
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        status,
      );
    }
  };
}

/** Служебные маршруты — только для администратора приложения. */
export function adminOnly(user: User) {
  if (!user.is_admin) throw new ApiError(403, "Только для админа");
}

export function intParam(
  value: string | null | undefined,
  name: string,
): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new ApiError(400, `Некорректный параметр ${name}`);
  return n;
}
