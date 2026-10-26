import { NextResponse } from "next/server";
import { ApiError, authed, json } from "@/server/route";
import { getSession, getUserById, type User } from "@/server/session";
import { exchangeCode, whoami } from "@/server/shikimori";
import { saveTokens, syncUser } from "@/server/sync";

async function link(user: User, code: string) {
  const tokens = await exchangeCode(code.trim());
  const profile = await whoami(tokens.access_token);
  saveTokens(user.id, tokens, profile);
  // Первый импорт списка
  const stats = await syncUser(getUserById(user.id)!);
  return { nickname: profile.nickname, stats };
}

/** Redirect-режим: Shikimori возвращает сюда ?code=...&state=... */
export const GET = authed(async (req, user) => {
  const url = new URL(req.url);
  const session = await getSession();
  const expected = session.shikiState;
  if (!expected || url.searchParams.get("state") !== expected) throw new ApiError(400, "Неверный state, начни привязку заново");
  const code = url.searchParams.get("code");
  if (!code) throw new ApiError(400, "Shikimori не вернул код авторизации");
  await link(user, code);
  return NextResponse.redirect(new URL("/settings?shikimori=linked", url.origin));
});

/** OOB-режим: код, показанный Shikimori, вставляется вручную */
export const POST = authed(async (req, user) => {
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code?.trim()) throw new ApiError(400, "Вставь код авторизации");
  return json(await link(user, code));
});
