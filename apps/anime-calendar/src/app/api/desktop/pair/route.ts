import { beginPairing, deviceByToken } from "@/server/desktop";
import { ApiError, json } from "@/server/route";
export async function POST(req: Request) {
  try {
    const body = await req.json();
    return json(beginPairing(body.label, body.platform));
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Ошибка привязки" },
      e instanceof ApiError ? e.status : 400,
    );
  }
}
export async function GET(req: Request) {
  try {
    const d = deviceByToken(
      (req.headers.get("authorization") || "").replace(/^Bearer /, ""),
      true,
    );
    return json({ approved: Boolean(d.user_id) });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Ошибка привязки" },
      401,
    );
  }
}
