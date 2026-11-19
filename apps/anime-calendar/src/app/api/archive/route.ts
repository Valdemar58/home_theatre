import { startTask } from "@/server/tasks";
import "@/server/archive";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Кнопка «Сохранить» на календаре: тайтлы показанного периода — в архив (фоновая задача с уведомлением)
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const { from, to } = (await req.json()) as { from?: number; to?: number };
  if (!Number.isInteger(from) || !Number.isInteger(to) || to! <= from! || to! - from! > 120 * 86400) throw new ApiError(400, "Некорректный период");
  const task = await startTask("archive", `${from}-${to}`, { userId: user.id, origin: "user", notify: true });
  return json({ task });
});
