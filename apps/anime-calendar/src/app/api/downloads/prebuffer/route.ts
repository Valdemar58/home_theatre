import "@/server/prebuffer";
import { adminOnly, ApiError, authed, json } from "@/server/route";
import { cancelTask, startTask } from "@/server/tasks";

const keyOf = (body: { hash?: unknown; index?: unknown }) => {
  if (typeof body.hash !== "string" || !/^[0-9a-f]{40}$/.test(body.hash) || !Number.isInteger(body.index)) throw new ApiError(400, "Неверная серия");
  return `${body.hash}:${body.index}`;
};

/** Подготовить серию (фоновая задача, уведомление — когда можно смотреть без остановок). */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const key = keyOf(await req.json().catch(() => ({})));
  return json({ task: await startTask("prebuffer", key, { userId: user.id, origin: "user" }) });
});

/** Отменить подготовку. */
export const DELETE = authed(async (req, user) => {
  adminOnly(user);
  cancelTask("prebuffer", keyOf(await req.json().catch(() => ({}))));
  return json({ ok: true });
});
