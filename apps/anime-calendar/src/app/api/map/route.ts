import { db } from "@/server/db";
import { atlasStatus, loadAtlas, rebuildAtlas } from "@/server/reco/atlas";
import { ApiError, authed, json } from "@/server/route";

/** Карта тайтлов (общая) + личное поверх неё: мои рекомендации. Карты ещё нет — atlas: null и статус сборки. */
export const GET = authed(async (_req, user) => {
  const row = db.prepare<[number], { recs: string | null }>("SELECT recs FROM user_taste WHERE user_id = ?").get(user.id);
  const recs = row?.recs ? (JSON.parse(row.recs) as { items: { id: number }[] }).items.map((i) => i.id) : [];
  return json({ atlas: loadAtlas(), status: atlasStatus(), recs });
});

/** Пересобрать карту (админ): идёт в фоне, ход — в /api/map/status. */
export const POST = authed(async (_req, user) => {
  if (!user.is_admin) throw new ApiError(403, "Пересобрать карту может админ");
  void rebuildAtlas();
  return json(atlasStatus());
});
