import { bookReleases } from "@/server/books/releases";
import { authed, json } from "@/server/route";

/** Выход глав книг из моего списка за последние недели. */
export const GET = authed(async (_req, user) => json(await bookReleases(user.id)));
