import { authed, json, ApiError } from "@/server/route";
import { closeLease, selectSource, sourceState, viewerSignal } from "@/server/desktop-stream";
export const GET = authed(async (req, user) => {
  const q = new URL(req.url).searchParams;
  return json(q.has("lease") ? viewerSignal(q.get("lease")!, user.id) : sourceState(user.id, q.get("room") || ""));
});
export const POST = authed(async (req, user) => {
  if (req.headers.get("origin") && new URL(req.headers.get("origin")!).host !== req.headers.get("host")) throw new ApiError(403, "Чужой источник запроса");
  const text = await req.text();
  if (text.length > 40000) throw new ApiError(413, "Слишком большой запрос");
  const b = JSON.parse(text);
  if (b.action === "select") { selectSource(user.id, String(b.room), b.device === null ? null : String(b.device)); return json({ ok: true }); }
  if (b.action === "close") { closeLease(String(b.lease), user.id); return json({ ok: true }); }
  return json(viewerSignal(String(b.lease), user.id, b.offer, b.generation));
});
