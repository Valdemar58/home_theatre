import { bookImportStatus, startBookImport } from "@/server/books/lib-bookmarks";
import { ApiError, authed, json } from "@/server/route";

/** Импорт закладок mangalib и ranobelib: состояние и запуск. */
export const GET = authed(async (_req, user) => json(bookImportStatus(user)));

export const POST = authed(async (_req, user) => {
  try {
    return json(startBookImport(user));
  } catch (err) {
    throw new ApiError(400, err instanceof Error ? err.message : String(err));
  }
});
