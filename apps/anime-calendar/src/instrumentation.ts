export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMaintenanceHttpTracking } = await import("./server/maintenance-http");
    startMaintenanceHttpTracking();
    const { startJobs } = await import("./server/jobs");
    startJobs();
  }
}
