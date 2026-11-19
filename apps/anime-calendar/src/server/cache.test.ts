import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cache-"));

const { db, now } = await import("./db");
const { cached, purgeExpired, setCached } = await import("./cache");
const { HttpError } = await import("./http");
const { guarded, markOk, sourceDown, SourceDown, withServedLog } = await import("./sources");

const flush = () => new Promise((r) => setTimeout(r, 0));
const expire = (key: string, ago = 10) => db.prepare("UPDATE cache SET expires_at = ?, fetched_at = ? WHERE key = ?").run(now() - ago, now() - 1000, key);

beforeEach(() => {
  db.exec("DELETE FROM cache");
  markOk("anilist");
  delete process.env.SOURCES_OFFLINE;
});

describe("cached: хранилище с обновлением в фоне", () => {
  it("свежее — без вызова источника", async () => {
    setCached("media:v2:1", { a: 1 }, 3600);
    const fn = vi.fn(async () => ({ a: 2 }));
    expect(await cached("media:v2:1", { fresh: 3600 }, fn)).toEqual({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("устаревшее — сразу, обновление в фоне", async () => {
    setCached("media:v2:2", { a: 1 }, 3600);
    expire("media:v2:2");
    const fn = vi.fn(async () => ({ a: 2 }));
    expect(await cached("media:v2:2", { fresh: 3600 }, fn)).toEqual({ a: 1 });
    await flush();
    expect(fn).toHaveBeenCalledOnce();
    expect(await cached("media:v2:2", { fresh: 3600 }, fn)).toEqual({ a: 2 });
  });

  it("volatile ждёт обновления, при сбое — сохранённое", async () => {
    setCached("ru:sonarr-series", [1], 60);
    expire("ru:sonarr-series");
    expect(await cached("ru:sonarr-series", { fresh: 60 }, async () => [2])).toEqual([2]);
    expire("ru:sonarr-series");
    expect(await cached("ru:sonarr-series", { fresh: 60 }, async () => { throw new Error("нет"); })).toEqual([2]);
  });

  it("источник лежит — сохранённое любой давности, без вызова; отмечено для плашки", async () => {
    setCached("media:v2:3", { a: 1 }, 3600);
    expire("media:v2:3", 400 * 86400);
    process.env.SOURCES_OFFLINE = "anilist";
    const fn = vi.fn(async () => ({ a: 2 }));
    const { value, served } = await withServedLog(() => cached("media:v2:3", { fresh: 3600, source: "anilist" }, fn));
    expect(value).toEqual({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
    expect(served.has("anilist")).toBe(true);
  });

  it("источник лежит, сохранённого нет — SourceDown", async () => {
    process.env.SOURCES_OFFLINE = "anilist";
    await expect(cached("media:v2:4", { fresh: 3600, source: "anilist" }, async () => 1)).rejects.toBeInstanceOf(SourceDown);
  });

  it("данные о тайтлах не удаляются, выдачи и состояние — по сроку", () => {
    setCached("media:v2:5", 1, 1);
    setCached("browse:x", 1, 1);
    setCached("seerr-users", 1, 1);
    expire("media:v2:5", 400 * 86400);
    expire("browse:x", 31 * 86400);
    expire("seerr-users", 2 * 86400);
    purgeExpired();
    const keys = db.prepare<[], { key: string }>("SELECT key FROM cache").all().map((r) => r.key);
    expect(keys).toEqual(["media:v2:5"]);
  });
});

describe("предохранитель источника", () => {
  it("сбой сети открывает, удача закрывает; ошибка запроса (404) — нет", async () => {
    await expect(guarded("anilist", async () => { throw new HttpError(404, "нет"); })).rejects.toThrow();
    expect(sourceDown("anilist")).toBe(false);
    await expect(guarded("anilist", async () => { throw new TypeError("fetch failed"); })).rejects.toThrow();
    expect(sourceDown("anilist")).toBe(true);
    await expect(guarded("anilist", async () => 1)).rejects.toBeInstanceOf(SourceDown);
    markOk("anilist");
    expect(await guarded("anilist", async () => 1)).toBe(1);
  });
});
