import { ApiError, authed, json } from "@/server/route";
import { latestTask, startTask } from "@/server/tasks";
import { env } from "@/server/env";

const KINDS = ["voices"];

const parse = (kind: unknown, key: unknown) => {
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new ApiError(400, "Неизвестная задача");
  if (typeof key !== "string" || !/^\d+$/.test(key)) throw new ApiError(400, "Неверный ключ");
  return { kind, key };
};

/** Последняя задача по ключу: GET /api/tasks?kind=voices&key=<id> */
export const GET = authed(async (req) => {
  const p = new URL(req.url).searchParams;
  const { kind, key } = parse(p.get("kind"), p.get("key"));
  return json({ task: latestTask(kind, key) });
});

/** Запустить (или присоединиться): { kind, key, origin: "user" | "auto" } */
export const POST = authed(async (req, user) => {
  const body = (await req.json().catch(() => ({}))) as { kind?: string; key?: string; origin?: string };
  const { kind, key } = parse(body.kind, body.key);
  if (kind === "voices" && (!env.prowlarrUrl || !env.prowlarrApiKey))
    throw new ApiError(503, "Поиск раздач не подключён. Добавьте torrent-файл или magnet-ссылку на устройство.");
  const origin = body.origin === "auto" ? "auto" : "user";
  return json({ task: await startTask(kind, key, { userId: user.id, origin }) });
});
