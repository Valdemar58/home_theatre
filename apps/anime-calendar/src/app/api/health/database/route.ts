import { db } from "@/server/db";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    const row = db.prepare<[], { ok: number }>("SELECT 1 AS ok").get();
    if (row?.ok !== 1) throw new Error("Database unavailable");
    return Response.json({ ok: true, database: process.env.DATABASE_DRIVER === "sqlite" ? "sqlite" : "postgres" });
  } catch { return Response.json({ ok: false }, { status: 503 }); }
}
