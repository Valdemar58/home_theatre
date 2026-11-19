import { groupsForTitle, roomGroup } from "@/server/groups";
import { createRoom, inviteable, roomForTitle } from "@/server/rooms";
import { ApiError, authed, intParam, json } from "@/server/route";

// Комнаты совместного просмотра: моя комната тайтла (вошёл или позвали) и кого можно позвать; создать комнату
export const GET = authed(async (req, user) => {
  const anilistId = intParam(new URL(req.url).searchParams.get("anilistId") ?? "", "anilistId");
  return json({ room: roomForTitle(user.id, anilistId), friends: inviteable(user.id), groups: groupsForTitle(user.id, anilistId) });
});

export const POST = authed(async (req, user) => {
  const b = (await req.json().catch(() => ({}))) as { anilistId?: number; ep?: number; invite?: number[]; pos?: number; playing?: boolean; group?: number };
  if (!Number.isInteger(b.anilistId) || !Number.isInteger(b.ep)) throw new ApiError(400, "Неверный запрос");
  return json(createRoom(user, b.anilistId!, b.ep!, (b.invite ?? []).map(Number), Number(b.pos) || 0, Boolean(b.playing),
    // «Позвать группу»: все её участники, пресет и пульт группы
    b.group ? roomGroup(user.id, Number(b.group)) : undefined));
});
