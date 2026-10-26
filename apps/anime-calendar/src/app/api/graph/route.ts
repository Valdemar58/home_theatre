import { cached, setCached } from "@/server/cache";
import { authed, json } from "@/server/route";
import { buildGraph } from "@/server/reco/graph";

/** Граф тайтлов с кластерами и раскладкой (кэш на 30 минут; ?refresh=1 — пересчитать) */
export const GET = authed(async (req, user) => {
  const key = `graph:${user.id}`;
  if (new URL(req.url).searchParams.get("refresh") === "1") {
    const graph = await buildGraph(user.id);
    setCached(key, graph, 30 * 60);
    return json(graph);
  }
  return json(await cached(key, 30 * 60, () => buildGraph(user.id)));
});
