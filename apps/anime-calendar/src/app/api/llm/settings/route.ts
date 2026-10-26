import type { LlmSettings, LlmStatus } from "@/lib/llm-tasks";
import { breakerState, embedAvailable, ollamaAvailable } from "@/server/llm";
import { EMBED_MODEL, external, getLlmConfig, LLM_MODEL, resetLlmConfig, saveLlmConfig } from "@/server/llm-config";
import { monthSpend } from "@/server/llm-usage";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Настройки ИИ (для админа):
//   GET    — настройки, состояние Ollama и внешнего API, траты за месяц (ключ не отдаётся — только «задан» и хвост);
//   PUT    — частичная правка { mode, cheap, smart, budgetUsd, tasks, upgrade, prices };
//   DELETE — сбросить правки к значениям из .env.

async function status(): Promise<LlmStatus> {
  const settings = getLlmConfig();
  return {
    settings,
    key: { set: Boolean(external.apiKey), tail: external.apiKey ? external.apiKey.slice(-4) : null },
    ollama: { chat: await ollamaAvailable(), embed: await embedAvailable(), model: LLM_MODEL, embedModel: EMBED_MODEL },
    external: { url: external.url, breaker: breakerState() },
    month: { spent: monthSpend(), budget: settings.budgetUsd },
  };
}

export const GET = authed(async (_req, user) => {
  adminOnly(user);
  return json(await status());
});

export const PUT = authed(async (req, user) => {
  adminOnly(user);
  const body = (await req.json().catch(() => null)) as Partial<LlmSettings> | null;
  if (!body || typeof body !== "object") throw new ApiError(400, "Нужен JSON с настройками");
  try {
    saveLlmConfig(body);
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : String(e));
  }
  return json(await status());
});

export const DELETE = authed(async (_req, user) => {
  adminOnly(user);
  resetLlmConfig();
  return json(await status());
});
