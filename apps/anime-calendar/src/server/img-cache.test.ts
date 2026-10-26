import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "img-cache-"));
process.env.DATA_DIR = dir;
const { db, now } = await import("./db");
const { cleanupImages, LIMITS, originalUrl } = await import("./img-cache");

const DAY = 86400;
function put(key: string, variant: string, ageDays: number, bytes = 10) {
  const file = path.join("ab", `${key}.${variant}`);
  mkdirSync(path.join(dir, "img-cache", "ab"), { recursive: true });
  writeFileSync(path.join(dir, "img-cache", file), "x");
  db.prepare(`INSERT INTO img_cache (key, variant, url, file, content_type, bytes, created_at, last_access)
    VALUES (?, ?, 'u', ?, 'image/webp', ?, 0, ?)`).run(key, variant, file, bytes, now() - ageDays * DAY);
  return path.join(dir, "img-cache", file);
}
const has = (key: string, variant: string) =>
  Boolean(db.prepare("SELECT 1 FROM img_cache WHERE key = ? AND variant = ?").get(key, variant));

describe("cleanupImages: поэтапная очистка", () => {
  it("копии старше 14 дн удаляются, оригинал остаётся; оригинал старше 90 дн — целиком", async () => {
    const fresh = put("a1", "orig", 1);
    const oldThumb = put("a1", "thumb", 20);
    put("b2", "orig", 100);
    put("b2", "card", 100);
    await cleanupImages();
    expect(has("a1", "orig")).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(has("a1", "thumb")).toBe(false);
    expect(existsSync(oldThumb)).toBe(false);
    expect(has("b2", "orig")).toBe(false);
  });

  it("сверх потолка размера — давно не нужные картинки первыми", async () => {
    // 3 × 0.4 = 1.2 потолка → уходит самая давняя, остаётся 0.8 (очистка идёт до 90% потолка)
    const big = Math.ceil(LIMITS.maxBytes * 0.4);
    put("c3", "orig", 30, big);
    put("d4", "orig", 2, big);
    put("e5", "orig", 1, big);
    await cleanupImages();
    expect(has("c3", "orig")).toBe(false);
    expect(has("d4", "orig")).toBe(true);
    expect(has("e5", "orig")).toBe(true);
  });
});

describe("originalUrl", () => {
  it("TMDB → оригинальный размер, остальное как есть", () => {
    expect(originalUrl("https://image.tmdb.org/t/p/w342/abc.jpg")).toBe("https://image.tmdb.org/t/p/original/abc.jpg");
    expect(originalUrl("https://s4.anilist.co/x.jpg")).toBe("https://s4.anilist.co/x.jpg");
    expect(originalUrl("https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1-a.jpg"))
      .toBe("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-a.jpg");
  });
});
