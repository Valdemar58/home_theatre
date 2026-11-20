import "server-only";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { maintenance, maintenanceActive, maintenanceWork } from "./maintenance";
import { pauseRoomsForMaintenance } from "./rooms";
import { runningMaintenanceTasks, resumeTaskQueues } from "./tasks";
import { llmBusy } from "./llm";

const runtime = globalThis as unknown as { __maintenanceLoop?: ReturnType<typeof setInterval> };
export function maintenanceTick() {
  const plan = maintenance();
  if (!maintenanceActive()) { resumeTaskQueues(); return; }
  pauseRoomsForMaintenance();
  const busy = maintenanceWork();
  const tasks = runningMaintenanceTasks();
  const llm = llmBusy();
  const target = path.join(process.env.DATA_DIR ?? "./data", "maintenance-ack.json");
  const temporary = target + ".tmp";
  writeFileSync(temporary, JSON.stringify({ id: plan?.id, observedAt: Date.now(), ready: !!plan && Date.now() >= plan.startsAt + 10000 && busy.length === 0 && tasks === 0 && !llm, busy, tasks, llm }), { mode: 0o600 });
  renameSync(temporary, target);
}
export function startMaintenanceLoop() {
  if (runtime.__maintenanceLoop) return;
  runtime.__maintenanceLoop = setInterval(() => {
    try { maintenanceTick(); } catch (error) { console.error("[maintenance]", error instanceof Error ? error.message : "Pause failed"); }
  }, 1000);
  runtime.__maintenanceLoop.unref();
}
