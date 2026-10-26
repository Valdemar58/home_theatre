import { authed, json } from "@/server/route";
import { percentsFor } from "@/server/reco/card";
import { recommendations } from "@/server/reco/engine";

/** Рекомендации по вкусу; ?refresh=1 — пересчитать, не дожидаясь изменений в списках */
export const GET = authed(async (req, user) => {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const res = await recommendations(user.id, force);
  // Процент на карточке — тот же «понравится», что во всплывающей карточке и на странице тайтла
  // (перцентиль среди популярного), а не внутренний балл подборки; порядок — по нему (при равенстве — как в подборке)
  const pct = await percentsFor(user.id, res.items.map((i) => i.id)).catch(() => new Map<number, number>());
  const items = res.items.map((i, order) => ({ ...i, match: pct.get(i.id) ?? i.match, order }))
    .sort((a, b) => b.match - a.match || a.order - b.order)
    .map(({ order: _order, ...i }) => i);
  return json({ ...res, items });
});
