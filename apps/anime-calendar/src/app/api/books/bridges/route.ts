import { bridgesState, setBridges, setSuwayomiRepo, suwayomiExtension } from "@/server/books/bridges";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Мосты к чужим расширениям (TASKS 5.9): плагины LNReader и Suwayomi — состояние и настройка (админ).

export const GET = authed(async (_req, user) => {
  adminOnly(user);
  return json(await bridgesState());
});

/** { plugins?, index?, sources? } — включённые плагины LNReader, адрес индекса, источники Suwayomi для поиска. */
export const PUT = authed(async (req, user) => {
  adminOnly(user);
  const b = (await req.json().catch(() => ({}))) as { plugins?: string[]; index?: string; sources?: string[] };
  setBridges({ plugins: b.plugins?.map(String), index: b.index, sources: b.sources?.map(String) });
  return json({ ok: true });
});

/** { repo } — репозиторий расширений Suwayomi; { install | uninstall | update: pkgName } — расширение. */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const b = (await req.json().catch(() => ({}))) as { repo?: string; install?: string; uninstall?: string; update?: string };
  try {
    if (b.repo !== undefined) await setSuwayomiRepo(b.repo.trim());
    for (const a of ["install", "uninstall", "update"] as const) if (b[a]) await suwayomiExtension(b[a]!, a);
  } catch (e) {
    throw new ApiError(502, e instanceof Error ? e.message : String(e));
  }
  return json({ ok: true });
});
