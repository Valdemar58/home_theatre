import { describe, expect, it } from "vitest";
import { planUpscale } from "./upscale-plan";

const c = { model: "realesr-animevideov3", target: 1000, maxScale: 4, minSrc: 150 };

describe("planUpscale", () => {
  it("обложка AniList 460px → ×3 (наименьший, что достаёт до 1000)", () => expect(planUpscale(460, c)).toBe(3));
  it("230px → ×4 (наибольший допустимый — до цели не достаёт)", () => expect(planUpscale(230, c)).toBe(4));
  it("уже крупная — не трогаем", () => expect(planUpscale(1200, c)).toBeNull());
  it("совсем маленькая — не трогаем", () => expect(planUpscale(100, c)).toBeNull());
  it("потолок масштаба", () => expect(planUpscale(230, { ...c, maxScale: 2 })).toBe(2));
  it("модель только ×4 при потолке ×2 — апскейла нет", () => expect(planUpscale(460, { ...c, model: "realesrgan-x4plus-anime", maxScale: 2 })).toBeNull());
});
