import { roomCommand, roomReport, roomView, roomPoll, type RoomCommand } from "@/server/rooms";
import { authed, json } from "@/server/route";

// Комната: снимок; команды (вход/выход, приглашения, права, пауза/перемотка/серия); отчёт плеера (ответ — часы сервера)
export const GET = authed<{ rid: string }>(async (req, user, { rid }) => json(new URL(req.url).searchParams.get("poll") === "1" ? roomPoll(user.id, rid) : roomView(user.id, rid)));

export const POST = authed<{ rid: string }>(async (req, user, { rid }) => {
  const b = (await req.json().catch(() => ({}))) as RoomCommand | ({ action: "report" } & Parameters<typeof roomReport>[2]);
  if (b.action === "report") return json(roomReport(user.id, rid, b));
  return json(roomCommand(user, rid, b));
});
