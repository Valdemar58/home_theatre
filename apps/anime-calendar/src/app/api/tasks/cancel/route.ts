import { authed, json } from "@/server/route";
import { cancelAuto } from "@/server/tasks";

/** Ушли со страницы, не нажав кнопку: отменить автоматическую задачу (navigator.sendBeacon). */
export const POST = authed(async (req, user) => {
  const body = JSON.parse((await req.text().catch(() => "")) || "{}") as { kind?: string; key?: string };
  if (body.kind && body.key) cancelAuto(body.kind, body.key, user.id);
  return json({ ok: true });
});
