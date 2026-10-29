import { accountsView, syncSignups } from "@/server/accounts";
import { adminOnly, authed, json } from "@/server/route";

export const GET = authed(async (_req, user) => {
  adminOnly(user);
  // Заявки — сразу, не дожидаясь минутной проверки
  await syncSignups().catch(() => undefined);
  return json(await accountsView());
});
