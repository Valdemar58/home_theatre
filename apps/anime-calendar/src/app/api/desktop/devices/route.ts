import {
  approveDevice,
  ownDevices,
  pairingInfo,
  revokeDevice,
} from "@/server/desktop";
import { authed, ApiError, json } from "@/server/route";
export const GET = authed(async (req, user) => {
  const id = new URL(req.url).searchParams.get("pair");
  return json(id ? pairingInfo(id) : ownDevices(user.id));
});
export const POST = authed(async (req, user) => {
  if (
    !req.headers.get("origin") ||
    new URL(req.headers.get("origin")!).host !== req.headers.get("host")
  )
    throw new ApiError(403, "Подтвердите действие на сайте");
  const b = await req.json();
  if (b.action === "approve") approveDevice(String(b.id), user.id);
  else if (b.action === "revoke") revokeDevice(String(b.id), user.id);
  else throw new ApiError(400, "Неизвестное действие");
  return json({ ok: true });
});
