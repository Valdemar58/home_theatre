import { isCacheable } from "@/lib/img";
import { UPSCALE_MODELS } from "@/lib/upscale-plan";
import { originalFile, upscaleInput } from "@/server/img-cache";
import { ApiError, authed, json } from "@/server/route";
import { callUpscaler, upscaleInfo, upscaleStats, upscalerHealth } from "@/server/upscale";

// Лаборатория ИИ-апскейла (страница для админа):
//   GET                — состояние апскейлера и сводка;
//   GET ?info=<адрес>  — исходник (ширина) и как сделан продовый апскейл (модель, масштаб, время);
//   GET ?id=<прогон>   — результат ручного прогона (PNG);
//   POST { url, model, scale } — ручной прогон (в кэш картинок не пишется; в памяти последние 24).

const results = new Map<string, Buffer>();

const adminOnly = (isAdmin: number) => { if (!isAdmin) throw new ApiError(403, "Только для админа"); };

export const GET = authed(async (req, user) => {
  adminOnly(user.is_admin);
  const p = new URL(req.url).searchParams;
  const id = p.get("id");
  if (id) {
    const png = results.get(id);
    if (!png) throw new ApiError(404, "Результат устарел — запустите ещё раз");
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } });
  }
  const info = p.get("info");
  if (info) {
    if (!isCacheable(info)) throw new ApiError(400, "Картинка не из AniList / Shikimori / TMDB");
    const src = await originalFile(info);
    return json({ srcWidth: src.width, upscale: upscaleInfo(info) });
  }
  return json({ health: await upscalerHealth(), ...upscaleStats() });
});

export const POST = authed(async (req, user) => {
  adminOnly(user.is_admin);
  const { url, model, scale } = (await req.json().catch(() => ({}))) as { url?: string; model?: string; scale?: number };
  if (!url || !isCacheable(url)) throw new ApiError(400, "Нужен адрес картинки AniList / Shikimori / TMDB");
  if (!model || !UPSCALE_MODELS[model]?.includes(Number(scale))) throw new ApiError(400, "Модель не умеет такой масштаб");
  const src = await originalFile(url);
  const { png, ms } = await callUpscaler(await upscaleInput(src.file), model, Number(scale));
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  results.set(id, png);
  while (results.size > 24) results.delete(results.keys().next().value!);
  const sharp = (await import("sharp")).default;
  const meta = await sharp(png).metadata();
  return json({ id, ms, srcWidth: src.width, outWidth: meta.width ?? 0, bytes: png.length });
});
