import { roomCommand, roomReport, roomView, type RoomCommand } from "@/server/rooms";
import { authed, json } from "@/server/route";

// Комната: снимок; команды (вход/выход, приглашения, права, пауза/перемотка/серия); отчёт плеера (ответ — часы сервера)
export const GET = authed<{ rid: string }>(async (_req, user, { rid }) => json(roomView(user.id, rid)));

export const POST = authed<{ rid: string }>(async (req, user, { rid }) => {
  const b = (await req.json().catch(() => ({}))) as RoomCommand | { action: "report"; buffering?: boolean; bw?: number; rtt?: number; drift?: number };
  if (b.action === "report") return json(roomReport(user.id, rid, b));
  return json(roomCommand(user, rid, b));
});
