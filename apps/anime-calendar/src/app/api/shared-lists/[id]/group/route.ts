import { groupAction, groupPlan, type GroupAction } from "@/server/groups";
import { authed, intParam, json } from "@/server/route";

// Группа просмотра: план (пресет, пульт, очередь, сеансы, голосование) и действия с ним
export const GET = authed<{ id: string }>(async (_req, user, { id }) => json(groupPlan(user.id, intParam(id, "id"))));

export const POST = authed<{ id: string }>(async (req, user, { id }) =>
  json(groupAction(user, intParam(id, "id"), (await req.json().catch(() => ({}))) as GroupAction)));
