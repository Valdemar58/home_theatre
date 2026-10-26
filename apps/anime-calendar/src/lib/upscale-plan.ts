// Сколько раз увеличивать картинку ИИ-апскейлом. Правила:
//  • меньше minSrc px по ширине — не трогаем: из «иконки» модель дорисует кашу;
//  • уже не меньше цели (target px) — не нужно;
//  • масштаб — из поддерживаемых моделью (свои веса под каждый: ×2/×3/×4), не больше maxScale;
//    берём наименьший, что достаёт до цели, иначе наибольший допустимый.
// Результат потом ужимается до цели — лишние пиксели не храним.

export const UPSCALE_MODELS: Record<string, number[]> = {
  "realesr-animevideov3": [2, 3, 4],
  "realesrgan-x4plus-anime": [4],
  "realesrgan-x4plus": [4],
};

export type UpscaleConfig = { model: string; target: number; maxScale: number; minSrc: number };

export function planUpscale(width: number, c: UpscaleConfig): number | null {
  if (!width || width < c.minSrc || width >= c.target) return null;
  const scales = (UPSCALE_MODELS[c.model] ?? []).filter((s) => s <= c.maxScale).sort((a, b) => a - b);
  if (!scales.length) return null;
  return scales.find((s) => width * s >= c.target) ?? scales.at(-1)!;
}
