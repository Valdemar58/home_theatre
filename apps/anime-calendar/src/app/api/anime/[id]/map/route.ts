import { mapView } from "@/server/plot-map";
import { adminOnly, authed, intParam, json } from "@/server/route";
import { latestTask, startTask } from "@/server/tasks";

/** Карта мест на «Сюжет на серию». */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(await mapView(user.id, intParam(id, "id"))));

/** Найти карту на вики, прочитать подписи и расставить места (только админ: модель со зрением, долго). */
export const POST = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  await startTask("map", String(n), { userId: user.id, origin: "user", notify: true });
  return json({ task: latestTask("map", String(n)) });
});
