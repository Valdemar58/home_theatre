import "server-only";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beginMaintenanceWork } from "./maintenance";

const runtime = globalThis as unknown as { __maintenanceHttpStop?: () => void };
/** Include bearer-token routes and requests still receiving their bodies. */
export function startMaintenanceHttpTracking() {
  if (runtime.__maintenanceHttpStop) return runtime.__maintenanceHttpStop;
  const started = (message: unknown) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) return;
    const finish = beginMaintenanceWork("http-write");
    response.once("finish", finish);
    response.once("close", finish);
  };
  subscribe("http.server.request.start", started);
  const stop = () => { unsubscribe("http.server.request.start", started); runtime.__maintenanceHttpStop = undefined; };
  runtime.__maintenanceHttpStop = stop;
  return stop;
}
