import { ssoConfigured } from "@/server/env";
import { jellyfinLogin } from "@/server/jellyfin";
import {
  clientIp,
  isRemote,
  loginFailed,
  loginOk,
  loginWait,
} from "@/server/remote";
import { json } from "@/server/route";
import { getSession, upsertUser } from "@/server/session";

export async function legacyLogin(req: Request) {
  const { username, password } = (await req.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  if (!username) return json({ error: "Введите имя пользователя" }, 400);
  // Снаружи — не больше 8 неудачных попыток за 15 минут с одного адреса
  // С единым входом пароль Jellyfin — только запасной путь из дома
  if (ssoConfigured() && isRemote(req))
    return json({ error: "Вход — через кнопку «Войти»" }, 403);
  const ip = clientIp(req);
  const wait = ip === "local" ? 0 : loginWait(ip);
  if (wait)
    return json(
      {
        error: `Слишком много попыток входа — попробуйте через ${Math.ceil(wait / 60)} мин`,
      },
      429,
    );
  try {
    const jf = await jellyfinLogin(username, password ?? "");
    if (!jf) {
      if (ip !== "local") loginFailed(ip);
      return json({ error: "Неверное имя пользователя или пароль" }, 401);
    }
    loginOk(ip);
    const user = upsertUser(jf.id, jf.name, jf.isAdmin);
    if (user.blocked)
      return json({ error: "Учётная запись заблокирована" }, 403);
    const session = await getSession();
    session.userId = user.id;
    await session.save();
    return json({ ok: true, name: user.name });
  } catch (err) {
    return json(
      {
        error: `Jellyfin недоступен: ${err instanceof Error ? err.message : err}`,
      },
      502,
    );
  }
}
