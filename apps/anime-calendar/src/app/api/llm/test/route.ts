import { testPool } from "@/server/llm";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Пробный вызов пула { pool: local | cheap | smart }: ключ, модель, задержка, токены и цена.
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const { pool } = (await req.json().catch(() => ({}))) as { pool?: string };
  if (pool !== "local" && pool !== "cheap" && pool !== "smart") throw new ApiError(400, "pool — local, cheap или smart");
  return json(await testPool(pool));
});
