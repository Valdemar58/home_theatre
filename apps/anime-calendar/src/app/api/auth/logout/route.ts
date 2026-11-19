import { env, ssoConfigured } from "@/server/env";
import { json } from "@/server/route";
import { getSession } from "@/server/session";

export async function POST() {
  const session = await getSession();
  session.destroy();
  // С единым входом — выйти и из Authentik, иначе «Войти» сразу пустит обратно того же человека
  return json({ ok: true, redirect: ssoConfigured() ? `${env.authPublicUrl}/application/o/kino-calendar/end-session/` : null });
}
