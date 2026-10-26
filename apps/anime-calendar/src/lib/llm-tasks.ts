// Задачи LLM и настройки маршрутизации — общие для сервера и карточки «ИИ» в настройках.
import type { Price } from "./llm-pricing";

export const LLM_TASKS = ["analysis", "synopsis", "recap", "portrait", "rerank", "tags", "cluster", "plot_deep", "translate"] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

/** Куда идёт задача: локальная модель, дешёвая или умная внешняя. */
export type Pool = "local" | "cheap" | "smart";
/** auto — по пулам задач; local — только Ollama; external — всё внешнее; off — без LLM. */
export type LlmMode = "auto" | "local" | "external" | "off";

export const TASK_LABELS: Record<LlmTask, { title: string; hint: string }> = {
  analysis: { title: "Разбор тайтла", hint: "тон, темы, шкалы — для рекомендаций и «похожего», один раз на тайтл" },
  synopsis: { title: "Синопсис вместо заглушки", hint: "один раз на тайтл без нормального описания" },
  recap: { title: "«Что было раньше»", hint: "пересказ предыдущих частей по кнопке" },
  portrait: { title: "Портрет вкуса", hint: "при изменении списка" },
  rerank: { title: "Подборка и объяснения", hint: "самая дорогая: при изменении списка, не чаще раза в 12 ч" },
  tags: { title: "Перевод тегов", hint: "редко, только новые теги AniList" },
  cluster: { title: "Названия островов карты", hint: "при пересборке карты" },
  plot_deep: { title: "Пересказ сезона", hint: "после «Собрать сюжет»: слепо по порядку, порциями по 4 серии; пересказ, серии по-русски, персонажи, термины" },
  translate: { title: "Перевод пересказов серий", hint: "по кнопке у серии, один раз на текст; Fandom — до 17 тыс. символов на серию" },
};

export type LlmSettings = {
  mode: LlmMode;
  cheap: string;
  smart: string;
  tasks: Record<LlmTask, Pool>;
  /** Перезапускать ли старые результаты более сильной моделью */
  upgrade: Partial<Record<LlmTask, boolean>>;
  budgetUsd: number;
  prices: Record<string, Price>;
};

/** «recap:smart,rerank:cheap» → пулы задач (остальные — local). */
export function parseTaskPools(s: string | undefined): Record<LlmTask, Pool> {
  const out = Object.fromEntries(LLM_TASKS.map((t) => [t, "local"])) as Record<LlmTask, Pool>;
  for (const part of (s ?? "").split(",")) {
    const [task, pool = "cheap"] = part.trim().split(":").map((x) => x.trim());
    if ((LLM_TASKS as readonly string[]).includes(task) && ["local", "cheap", "smart"].includes(pool)) out[task as LlmTask] = pool as Pool;
  }
  return out;
}

/** Статус для карточки настроек (без ключа). */
export type LlmStatus = {
  settings: LlmSettings;
  key: { set: boolean; tail: string | null };
  ollama: { chat: boolean; embed: boolean; model: string; embedModel: string };
  external: { url: string; breaker: string | null };
  month: { spent: number; budget: number };
};

export type LlmUsageRow = {
  task: string; provider: string; model: string; calls: number; errors: number;
  prompt: number; cacheHit: number; completion: number; cost: number;
};
