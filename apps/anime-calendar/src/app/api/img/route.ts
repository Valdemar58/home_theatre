import { isCacheable, type ImgSize } from "@/lib/img";
import { cachedImage } from "@/server/img-cache";

const SIZES: ImgSize[] = ["tiny", "thumb", "card", "full"];

/** Картинка из серверного кэша: /api/img?u=<адрес источника>&s=tiny|thumb|card|full&v=<версия>[&up=1 — после ИИ-апскейла]. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("u") ?? "";
  const size = (searchParams.get("s") ?? "full") as ImgSize;
  if (!SIZES.includes(size) || !isCacheable(url)) return new Response("Не поддерживается", { status: 400 });
  try {
    // up=1 — версия после ИИ-апскейла (если ещё не готова — обычная, но без вечного кэша в браузере)
    const wantUp = searchParams.get("up") === "1";
    const img = await cachedImage(url, size, { upscaled: wantUp });
    if (req.headers.get("if-none-match") === img.etag) return new Response(null, { status: 304, headers: { ETag: img.etag } });
    return new Response(new Uint8Array(img.body), {
      headers: {
        "Content-Type": img.type,
        "Cache-Control": wantUp && !img.upscaled ? "no-store" : "public, max-age=31536000, immutable",
        ETag: img.etag,
      },
    });
  } catch (err) {
    // Не смогли скачать/обработать — пусть браузер возьмёт картинку у источника
    console.warn(`[img] ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return Response.redirect(url, 302);
  }
}
