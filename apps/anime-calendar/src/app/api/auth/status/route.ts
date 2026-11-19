import { authenticatedUser } from "@/server/session";
import { credential } from "@/server/local-accounts";
import { json } from "@/server/route";
export async function GET() {
  const user = await authenticatedUser();
  const r = json(
    user
      ? {
          id: user.id,
          name: user.name,
          access:
            credential(user.id)?.access ??
            (user.blocked ? "blocked" : "approved"),
        }
      : null,
  );
  r.headers.set("Cache-Control", "no-store");
  return r;
}
