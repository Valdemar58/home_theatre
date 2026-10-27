import { graphProgress, graphSummary } from "@/server/plot-graph-build";
import { adminOnly, authed, intParam, json } from "@/server/route";
import { cancelTask, latestTask, startTask } from "@/server/tasks";

// ?variant=b — второй прогон для замера стабильности (ключ задачи «<id>@b», в таблицы не пишется);
// ?graph=1 — свёрнутый граф прогона для сравнения
const keyOf = (req: Request, n: number) => {
  const v = new URL(req.url).searchParams.get("variant")?.replace(/[^a-z0-9]/gi, "") ?? "";
  return { key: v ? `${n}@${v}` : String(n), variant: v };
};

/** Пересобрать персонажей и события сезона по готовому пересказу (только админ: вызовы ИИ платные). */
export const GET = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const { key, variant } = keyOf(req, n);
  const graph = new URL(req.url).searchParams.has("graph") ? await graphSummary(n, variant) : undefined;
  return json({ task: latestTask("graph", key), progress: graphProgress(n), graph });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const { key } = keyOf(req, n);
  const silent = new URL(req.url).searchParams.has("silent");
  await startTask("graph", key, { userId: user.id, origin: "user", notify: !silent });
  return json({ task: latestTask("graph", key), progress: graphProgress(n) });
});

export const DELETE = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const { key } = keyOf(req, n);
  cancelTask("graph", key);
  return json({ task: latestTask("graph", key), progress: graphProgress(n) });
});
