import { usageByTask } from "@/server/llm-usage";
import { adminOnly, authed, json } from "@/server/route";

// Расход LLM за месяц (?month=YYYY-MM, по умолчанию текущий) по задаче × провайдеру × модели.
export const GET = authed(async (req, user) => {
  adminOnly(user);
  return json(usageByTask(new URL(req.url).searchParams.get("month") ?? undefined));
});
