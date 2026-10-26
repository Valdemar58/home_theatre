import { createList, myLists } from "@/server/together";
import { authed, json } from "@/server/route";

export const GET = authed(async (_req, user) => json(myLists(user.id)));

export const POST = authed(async (req, user) => {
  const { name, invite } = (await req.json()) as { name: string; invite?: number[] };
  const id = createList(user, String(name ?? ""), (invite ?? []).map(Number));
  return json({ id });
});
