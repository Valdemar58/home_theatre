import { maintenance, maintenanceActive } from "@/server/maintenance";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ protocol: 1, plan: maintenance(), active: maintenanceActive(), serverNow: Date.now() },
    { headers: { "Cache-Control": "no-store" } });
}
