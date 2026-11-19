import { legacyAuthEnabled } from "@/server/local-accounts";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/accounts";
import { ssoConfigured } from "@/server/env";
import { getSession } from "@/server/session";
import { authorizeStart, originOf } from "@/server/sso";

// Вход через Authentik: запомнить state и PKCE в сессии и отправить браузер на страницу входа
export async function GET(req: Request) {
  if (!legacyAuthEnabled())
    return NextResponse.redirect(new URL("/login", req.url));
  if (!ssoConfigured()) return NextResponse.redirect(`${originOf(req)}/login`);
  const { url, saved } = authorizeStart(
    req,
    safeNext(new URL(req.url).searchParams.get("next")),
  );
  const session = await getSession();
  session.oidc = saved;
  await session.save();
  return NextResponse.redirect(url);
}
