import { sameOrigin, legacyAuthEnabled } from "@/server/local-accounts";
import { env, ssoConfigured } from "@/server/env";
import { json } from "@/server/route";
import { getSession } from "@/server/session";

export async function POST(req: Request) {
  try {
    sameOrigin(req);
  } catch {
    return json({ error: "Чужой источник запроса" }, 403);
  }
  const session = await getSession();
  session.destroy();
  // С единым входом — выйти и из Authentik, иначе «Войти» сразу пустит обратно того же человека
  return json({
    ok: true,
    redirect:
      legacyAuthEnabled() && ssoConfigured()
        ? `${env.authPublicUrl}/application/o/kino-calendar/end-session/`
        : null,
  });
}
