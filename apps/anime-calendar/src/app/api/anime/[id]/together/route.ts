import type { TogetherState } from "@/lib/types";
import { coWatchers, listsForTitle, markTogether, sessionInfo } from "@/server/together";
import { authed, intParam, json } from "@/server/route";

// Совместный просмотр тайтла: кого можно отметить, мои общие списки, идущий «Смотрим вместе»
export const GET = authed<{ id: string }>(async (_req, user, { id }) => {
  const anilistId = intParam(id, "id");
  const state: TogetherState = { ...coWatchers(user.id, anilistId), lists: listsForTitle(user.id, anilistId), session: sessionInfo(user.id, anilistId) };
  return json(state);
});

/** «Посмотрели вместе»: marks — кому до какой серии. */
export const POST = authed<{ id: string }>(async (req, user, { id }) => {
  const { marks } = (await req.json()) as { marks: { userId: number; upTo: number }[] };
  return json(await markTogether(user, intParam(id, "id"), (marks ?? []).map((m) => ({ userId: Number(m.userId), upTo: Number(m.upTo) }))));
});
