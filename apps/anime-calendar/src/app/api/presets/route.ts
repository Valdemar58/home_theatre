import { deletePreset, listPresets, savePreset } from "@/server/presets";
import { authed, intParam, json } from "@/server/route";

export const GET = authed(async (_req, user) => json(listPresets(user.id)));

/** Создать ({ name, query }) или изменить ({ id, name?, query?, isDefault? }). */
export const POST = authed(async (req, user) => {
  const b = (await req.json()) as { id?: number; name?: string; query?: string; isDefault?: boolean };
  return json(savePreset(user.id, b));
});

export const DELETE = authed(async (req, user) => json(deletePreset(user.id, intParam(new URL(req.url).searchParams.get("id"), "id"))));
