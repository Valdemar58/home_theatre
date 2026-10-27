import { graphProgress } from "@/server/plot-graph-build";
import { adminOnly, authed, intParam, json } from "@/server/route";
import { cancelTask, latestTask, startTask } from "@/server/tasks";

/** Пересобрать персонажей и события сезона по готовому пересказу (только админ: вызовы ИИ платные). */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  return json({ task: latestTask("graph", String(n)), progress: graphProgress(n) });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const silent = new URL(req.url).searchParams.has("silent");
  await startTask("graph", String(n), { userId: user.id, origin: "user", notify: !silent });
  return json({ task: latestTask("graph", String(n)), progress: graphProgress(n) });
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  cancelTask("graph", String(n));
  return json({ task: latestTask("graph", String(n)), progress: graphProgress(n) });
});
