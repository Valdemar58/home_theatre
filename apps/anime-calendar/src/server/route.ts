import "server-only";
import { NextResponse } from "next/server";
import { HttpError } from "./http";
import { currentUser, type User } from "./session";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

type Ctx<P> = { params: Promise<P> };

/** Обёртка маршрута: проверка входа и единый формат ошибок. */
export function authed<P = Record<string, string>>(
  handler: (req: Request, user: User, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      const user = await currentUser();
      if (!user) return json({ error: "Нужно войти" }, 401);
      return await handler(req, user, await ctx.params);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      console.error(err);
      const status = err instanceof HttpError && err.status === 404 ? 404 : 502;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  };
}

/** Служебные маршруты — только для админа (Jellyfin-администратор). */
export function adminOnly(user: User) {
  if (!user.is_admin) throw new ApiError(403, "Только для админа");
}

export function intParam(value: string | null | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, `Некорректный параметр ${name}`);
  return n;
}
