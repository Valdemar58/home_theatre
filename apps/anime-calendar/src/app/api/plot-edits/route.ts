import { addEdit, editorData } from "@/server/plot-edits";
import { adminOnly, authed, intParam, json } from "@/server/route";

/** Редактор персонажа: ?entity=<сущность>&anilistId=<тайтл>. Только админ (этап 1, IDEAS #81). */
export const GET = authed(async (req, user) => {
  adminOnly(user);
  const q = new URL(req.url).searchParams;
  return json(await editorData(intParam(q.get("entity") ?? "", "entity"), intParam(q.get("anilistId") ?? "", "anilistId")));
});

/** Новая правка: { entityId, anilistId, kind, data, fromEp }. */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const b = (await req.json()) as { entityId: number; anilistId: number; kind: string; data: unknown; fromEp: number };
  return json(await addEdit(user, { entityId: Number(b.entityId), anilistId: Number(b.anilistId), kind: String(b.kind), data: b.data, fromEp: Number(b.fromEp) }));
});
