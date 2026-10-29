import { NextResponse } from "next/server";
import { getSession } from "@/server/session";
import { exchange, originOf, userForClaims } from "@/server/sso";

// Возврат из Authentik: сверить state, обменять код, привязать учётку календаря
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const session = await getSession();
  const saved = session.oidc;
  const fail = (why: string) => NextResponse.redirect(`${originOf(req)}/login?error=${encodeURIComponent(why)}`);
  if (!saved || q.get("state") !== saved.state) return fail("Вход устарел — попробуйте ещё раз");
  if (q.get("error")) return fail(q.get("error_description") || "Authentik отказал во входе");
  try {
    const claims = await exchange(q.get("code") ?? "", saved.verifier, saved.redirect);
    const user = await userForClaims(claims);
    if (user.blocked) return fail("Учётная запись заблокирована");
    session.userId = user.id;
    session.oidc = undefined;
    await session.save();
    return NextResponse.redirect(`${originOf(req)}${saved.next}`);
  } catch (err) {
    console.error(err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
