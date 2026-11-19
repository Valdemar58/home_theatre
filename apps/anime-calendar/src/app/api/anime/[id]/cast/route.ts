import { setPlotView, titleCast } from "@/server/plot-graph";
import { ApiError, authed, intParam, json } from "@/server/route";
import type { PlotViewMode } from "@/lib/types";

/** Персонажи тайтла на серию курсора (?at=all — весь сезон, ?at=N — на серию N: «показать спойлер»). */
export const GET = authed<{ id: string }>(async (req, user, { id }) => {
  const at = new URL(req.url).searchParams.get("at");
  return json(await titleCast(user.id, intParam(id, "id"), at === "all" ? 1e6 : at ? intParam(at, "at") : undefined));
});

/** «Сюжет на серию»: мой прогресс, выбранная серия или весь сезон (прогресс в списке не меняется). */
export const PUT = authed<{ id: string }>(async (req, user, { id }) => {
  const { mode, ep } = (await req.json()) as { mode: PlotViewMode; ep?: number | null };
  if (!["progress", "ep", "all"].includes(mode)) throw new ApiError(400, "Неизвестный режим");
  setPlotView(user.id, intParam(id, "id"), mode, mode === "ep" ? Math.max(0, Math.round(Number(ep) || 0)) : null);
  return json(await titleCast(user.id, intParam(id, "id")));
});
