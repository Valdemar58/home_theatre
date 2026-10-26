import { authed, json } from "@/server/route";
import { upscaleStatus, type UpSize } from "@/server/upscale";

/**
 * ИИ-апскейл: состояния картинок пачкой { items: [{ url, size: "card" | "full" }] } →
 * { "<size>:<url>": "done" | "pending" | "none" } (заодно ставит нужные в очередь).
 */
export const POST = authed(async (req) => {
  const { items } = (await req.json().catch(() => ({}))) as { items?: unknown };
  const list = (Array.isArray(items) ? items : [])
    .filter((i): i is { url: string; size: UpSize } => typeof i?.url === "string" && (i.size === "card" || i.size === "full"))
    .slice(0, 200);
  return json(await upscaleStatus(list));
});
