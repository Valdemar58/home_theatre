import { bookPicks } from "@/server/books/for-you";
import { authed, json } from "@/server/route";

/** «Для тебя» в режимах книг: ?kind=manga|novel */
export const GET = authed(async (req, user) => json(await bookPicks(user.id, new URL(req.url).searchParams.get("kind") === "novel" ? "novel" : "manga")));
