import { archiveStats } from "@/server/archive";
import { authed, json } from "@/server/route";
import { sourcesHealth } from "@/server/sources";

// Состояние внешних источников (для плашки «показываю сохранённое») и архива тайтлов (админу)
export const GET = authed(async (_req, user) => {
  const sources = sourcesHealth();
  return json({ sources, archive: user.is_admin ? archiveStats() : null });
});
