import { jellyfinLogin } from "@/server/jellyfin";
import { json } from "@/server/route";
import { getSession, upsertUser } from "@/server/session";

export async function POST(req: Request) {
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  if (!username) return json({ error: "Введите имя пользователя" }, 400);
  try {
    const jf = await jellyfinLogin(username, password ?? "");
    if (!jf) return json({ error: "Неверное имя пользователя или пароль" }, 401);
    const user = upsertUser(jf.id, jf.name, jf.isAdmin);
    const session = await getSession();
    session.userId = user.id;
    await session.save();
    return json({ ok: true, name: user.name });
  } catch (err) {
    return json({ error: `Jellyfin недоступен: ${err instanceof Error ? err.message : err}` }, 502);
  }
}
