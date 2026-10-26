import { getDetails } from "@/server/anilist";
import { withShikimori } from "@/server/lists";
import { ensureRecap, plotOf } from "@/server/plot";
import { authed, intParam, json } from "@/server/route";

async function details(id: string) {
  const d = structuredClone(await getDetails(intParam(id, "id")));
  await withShikimori([d, ...d.relations.map((r) => r.media)]);
  return d;
}

/** Сюжет: серии с описаниями, синопсис от ИИ вместо заглушки (составляется в фоне), готовый пересказ. */
export const GET = authed<{ id: string }>(async (_req, _user, { id }) => json(await plotOf(await details(id))));

/** Составить «что было раньше» (ждёт LLM — до минуты-двух). */
export const POST = authed<{ id: string }>(async (_req, _user, { id }) => {
  const d = await details(id);
  await ensureRecap(d);
  return json(await plotOf(d));
});
