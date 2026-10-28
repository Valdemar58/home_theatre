import { db } from "@/server/db";
import { authed, intParam, json } from "@/server/route";
import "@/server/segments";
import { latestTask, startTask } from "@/server/tasks";

// Опенинги и эндинги по звуку: состояние поиска и найденные отрезки по сериям; POST — искать заново (досчитать новые)
const found = (id: number) => db.prepare<[number], { ep: number; kind: string; start: number; end: number }>(
  `SELECT ep, kind, start_s AS start, end_s AS "end" FROM episode_segments WHERE anilist_id = ? ORDER BY ep, start_s`).all(id);

export const GET = authed<{ id: string }>(async (_req, _user, { id }) => {
  const n = intParam(id, "id");
  return json({ task: latestTask("segments", String(n)), segments: found(n) });
});

export const POST = authed<{ id: string }>(async (_req, user, { id }) => {
  const n = intParam(id, "id");
  await startTask("segments", String(n), { userId: user.id, origin: "user", notify: false });
  return json({ task: latestTask("segments", String(n)), segments: found(n) });
});
