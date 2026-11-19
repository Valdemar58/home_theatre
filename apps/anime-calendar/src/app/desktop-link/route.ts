import { currentUser } from "@/server/session";
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("pair") || "";
  if (!/^[a-f0-9]{24}$/.test(id))
    return new Response("Некорректный код", { status: 400 });
  const destination = `/devices?pair=${id}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: (await currentUser())
        ? destination
        : `/login?next=${encodeURIComponent(destination)}`,
    },
  });
}
