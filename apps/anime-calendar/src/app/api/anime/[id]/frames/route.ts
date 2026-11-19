import { framesProgress } from "@/server/plot-frames";
import { adminOnly, authed, intParam, json } from "@/server/route";
import { cancelTask, latestTask, startTask } from "@/server/tasks";

/** Кадры из своих серий для обликов без картинки (только админ: долго, видеокарта). */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  return json({ task: latestTask("frames", String(n)), progress: framesProgress(n) });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  await startTask("frames", String(n), { userId: user.id, origin: "user", notify: !new URL(req.url).searchParams.has("silent") });
  return json({ task: latestTask("frames", String(n)), progress: framesProgress(n) });
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  cancelTask("frames", String(n));
  return json({ task: latestTask("frames", String(n)), progress: framesProgress(n) });
});
