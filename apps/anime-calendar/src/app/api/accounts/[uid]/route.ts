import { accountAction, type AccountAction } from "@/server/accounts";
import { adminOnly, ApiError, authed, intParam, json } from "@/server/route";

const ACTIONS: AccountAction[] = ["admin", "friend", "block", "unblock", "libraries-on", "libraries-off", "reset", "delete"];

export const POST = authed<{ uid: string }>(async (req, user, { uid }) => {
  adminOnly(user);
  const { action } = (await req.json().catch(() => ({}))) as { action?: AccountAction };
  if (!action || !ACTIONS.includes(action)) throw new ApiError(400, "Неизвестное действие");
  return json(await accountAction(user, intParam(uid, "uid"), action));
});
