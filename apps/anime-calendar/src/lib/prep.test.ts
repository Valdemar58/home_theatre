import { describe, expect, it } from "vitest";
import { canPrepare, GB, toEvict, type PrepItem, type PrepPolicy } from "./prep";

const DAY = 86400;
const P: PrepPolicy = { limitBytes: 10 * GB, minFreeBytes: 5 * GB, keepAfterWatchSec: 3 * DAY, ttlSec: 14 * DAY };
const now = 100 * DAY;
const item = (key: string, o: Partial<PrepItem> = {}): PrepItem => ({ key, size: GB, doneAt: now - DAY, watchedAt: null, usedAt: null, createdAt: now - 2 * DAY, ...o });

describe("toEvict", () => {
  it("досмотренные дольше срока и забытые дольше TTL", () => {
    expect(toEvict([
      item("watched-old", { watchedAt: now - 4 * DAY }),
      item("watched-new", { watchedAt: now - DAY }),
      item("forgotten", { doneAt: now - 20 * DAY }),
      item("used-recently", { doneAt: now - 20 * DAY, usedAt: now - DAY }),
      item("downloading", { doneAt: null, createdAt: now - 30 * DAY }),
    ], now, P).sort()).toEqual(["forgotten", "watched-old"]);
  });

  it("сверх лимита: сначала досмотренные, потом давно не запускавшиеся; качающиеся не трогаем", () => {
    const items = [
      item("a", { size: 4 * GB, doneAt: now - 10 * DAY, usedAt: now - 2 * DAY }),
      item("b", { size: 4 * GB, doneAt: now - 10 * DAY, usedAt: now - 5 * DAY }),
      item("c", { size: 3 * GB, watchedAt: now - DAY }),
      item("d", { size: 2 * GB, doneAt: null }),
    ];
    // 13 ГБ при лимите 10: уходит досмотренная c (3) → 10 — в лимите
    expect(toEvict(items, now, P)).toEqual(["c"]);
    expect(toEvict([...items, item("e", { size: 2 * GB, usedAt: now })], now, P)).toEqual(["c", "b"]);
  });
});

describe("canPrepare", () => {
  it("лимит и запас на диске", () => {
    expect(canPrepare(GB, 5 * GB, 50 * GB, P)).toEqual({ ok: true });
    expect(canPrepare(2 * GB, 9 * GB, 50 * GB, P)).toMatchObject({ ok: false, reason: expect.stringContaining("из 10 ГБ") });
    expect(canPrepare(2 * GB, 0, 6 * GB, P)).toMatchObject({ ok: false, reason: expect.stringContaining("свободно 6,0 ГБ") });
  });
});
