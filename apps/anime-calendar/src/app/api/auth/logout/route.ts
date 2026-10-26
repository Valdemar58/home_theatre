import { json } from "@/server/route";
import { getSession } from "@/server/session";

export async function POST() {
  const session = await getSession();
  session.destroy();
  return json({ ok: true });
}
