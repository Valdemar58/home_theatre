import "server-only";
import type { GlossaryEntry } from "@/lib/translate-text";
import { cached } from "./cache";
import { env } from "./env";
import { fetchWithRetry, HttpError, RateLimiter } from "./http";
import { guarded } from "./sources";

// Словарь имён персонажей тайтла по Shikimori (англ./яп. → рус.): для перевода и пересказа сезона.

const shikiLimiter = new RateLimiter(700);

/** Персонажи тайтла из Shikimori: английское и японское имя, синонимы → русское. */
export function characterGlossary(malId: number | null): Promise<GlossaryEntry[]> {
  if (!malId) return Promise.resolve([]);
  return cached(`shiki-chars:${malId}`, { fresh: 30 * 86400, source: "shikimori" }, () => guarded("shikimori", async () => {
    type Role = { rolesEn: string[]; character: { name: string; russian: string | null; japanese: string | null; synonyms: string[] } };
    const res = await fetchWithRetry(`${env.shikiUrl}/api/graphql`, {
      method: "POST",
      headers: { "User-Agent": env.shikiAppName, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: `{ animes(ids: "${malId}", limit: 1) { characterRoles { rolesEn character { name russian japanese synonyms } } } }` }),
    }, shikiLimiter);
    // Сбой — не «персонажей нет»: пусть останется сохранённое
    if (!res.ok) throw new HttpError(res.status, `Shikimori: ${res.status}`);
    const data = (await res.json()) as { data?: { animes?: { characterRoles?: Role[] }[] } };
    const roles = data.data?.animes?.[0]?.characterRoles ?? [];
    // Главные — первыми: при обрезке словаря они важнее
    return roles.sort((a, b) => Number(b.rolesEn.includes("Main")) - Number(a.rolesEn.includes("Main")))
      .filter((r) => r.character.russian)
      .map((r) => ({ names: [r.character.name, r.character.japanese ?? "", ...r.character.synonyms].map((n) => n.trim()).filter(Boolean), ru: r.character.russian! }));
  }));
}
