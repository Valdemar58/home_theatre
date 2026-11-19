import { adminOnly, authed, intParam, json } from "@/server/route";
import { sdhProgress } from "@/server/sdh";
import { latestTask, startTask } from "@/server/tasks";

/** «Глубокий разбор» по японским субтитрам (только админ: файлы локальные, конспекты платные). */
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  return json({ task: latestTask("sdh", String(n)), progress: sdhProgress(n) });
});

export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  adminOnly(user);
  const n = intParam(id, "id");
  const silent = new URL(req.url).searchParams.has("silent");
  await startTask("sdh", String(n), { userId: user.id, origin: "user", notify: !silent });
  return json({ task: latestTask("sdh", String(n)), progress: sdhProgress(n) });
});
