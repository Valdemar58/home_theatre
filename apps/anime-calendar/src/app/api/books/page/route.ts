import { allowedImage, pageImage } from "@/server/books/pages-cache";
import { ApiError, authed } from "@/server/route";

/** Картинка главы через календарь (Referer провайдера, свой кэш): ?p=<провайдер>&u=<адрес> */
export const GET = authed(async (req) => {
  const u = new URL(req.url);
  const url = u.searchParams.get("u") ?? "";
  if (!allowedImage(url)) throw new ApiError(400, "Картинка не с сайта провайдера");
  const img = await pageImage(u.searchParams.get("p") ?? "", url).catch((e) => { throw new ApiError(502, String(e)); });
  return new Response(new Uint8Array(img.body), { headers: { "Content-Type": img.type, "Cache-Control": "private, max-age=604800" } });
});
