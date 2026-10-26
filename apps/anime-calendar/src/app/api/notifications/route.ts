import { listNotices, updateNotices } from "@/server/notifications";
import { ApiError, authed, json } from "@/server/route";

// ?group=all|titles|friends|important&unread=1&before=<id>&limit=<n>
export const GET = authed(async (req, user) => {
  const p = new URL(req.url).searchParams;
  return json(await listNotices(user.id, {
    group: p.get("group") ?? undefined, unread: p.get("unread") === "1",
    before: Number(p.get("before")) || undefined, limit: Number(p.get("limit")) || undefined,
  }));
});

const ACTIONS = ["read", "unread", "delete", "delete-read"] as const;

/** { action: read|unread|delete|delete-read, ids?: number[], group? } — без ids: все во вкладке. */
export const POST = authed(async (req, user) => {
  const b = (await req.json().catch(() => ({}))) as { action?: (typeof ACTIONS)[number]; ids?: number[]; group?: string };
  const action = b.action ?? "read";
  if (!ACTIONS.includes(action)) throw new ApiError(400, "Неизвестное действие");
  updateNotices(user.id, action, Array.isArray(b.ids) ? b.ids.filter(Number.isInteger) : undefined, b.group);
  return json({ ok: true });
});
