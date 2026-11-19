import { deviceByToken, requireDesktopProtocol } from "@/server/desktop";
import { finishCommand, pendingCommands, reportDownloads } from "@/server/desktop-commands";
import { ApiError, json } from "@/server/route";
export async function POST(req: Request) {
  try {
    requireDesktopProtocol(req);
    const d = deviceByToken((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    const text = await req.text();
    if (text.length > 2600000) throw new ApiError(413, "Слишком большой запрос");
    const b = JSON.parse(text);
    if (b.receipt) finishCommand(d.id, String(b.receipt.id), b.receipt.result, b.receipt.error);
    if (b.jobs) reportDownloads(d.id, b.jobs, b.storage || b.capabilities ? {storage:b.storage,library:b.library,capabilities:b.capabilities} : undefined);
    return json({ commands: pendingCommands(d.id) });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Ошибка очереди" }, e instanceof ApiError ? e.status : 400); }
}
