import { ApiError, authed, json } from "@/server/route";
import { latestTask, startTask } from "@/server/tasks";
import "@/server/plot-align";

// Сопоставление серий сезона с главами книги по сюжету (TASKS 5.11): запуск задачи и её состояние.

const keyOf = (u: URLSearchParams | Record<string, unknown>) => {
  const get = (k: string) => Number(u instanceof URLSearchParams ? u.get(k) : u[k]);
  const anime = get("anime"), book = get("book");
  if (!(anime > 0) || !(book > 0)) throw new ApiError(400, "Нужны сезон и книга");
  return `${anime}|${book}`;
};

export const GET = authed(async (req) => json({ task: latestTask("align", keyOf(new URL(req.url).searchParams)) }));

export const POST = authed(async (req, user) => {
  const key = keyOf((await req.json()) as Record<string, unknown>);
  return json({ task: await startTask("align", key, { userId: user.id, origin: "user", notify: true }) });
});
