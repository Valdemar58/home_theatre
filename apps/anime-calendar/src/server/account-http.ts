import { json, ApiError } from "./route";
import { getSession } from "./session";
export const privateJson = (data: unknown, status = 200) => {
  const response = json(data, status);
  response.headers.set("Cache-Control", "no-store");
  return response;
};
export async function accountEndpoint(fn: () => Promise<Response> | Response) {
  try {
    const r = await fn();
    r.headers.set("Cache-Control", "no-store");
    return r;
  } catch (e) {
    return privateJson(
      {
        error:
          e instanceof ApiError
            ? e.message
            : "Не удалось выполнить действие. Повторите попытку.",
      },
      e instanceof ApiError ? e.status : 500,
    );
  }
}
export async function signIn(account: {
  id: number;
  version: number;
  access: string;
}) {
  const s = await getSession();
  s.userId = account.id;
  s.authVersion = account.version;
  s.oidc = undefined;
  s.shikiState = undefined;
  s.shikiRedirect = undefined;
  await s.save();
  return json({ ok: true, pending: account.access === "pending" });
}
