import { describe, expect, it } from "vitest";
import { canSee, friendState, watchMinutes } from "./social-rules";

describe("canSee", () => {
  it("себя видно всегда", () => expect(canSee(1, { id: 1, visibility: "private" }, "none")).toBe(true));
  it("«все» — видно всем", () => expect(canSee(2, { id: 1, visibility: "all" }, "none")).toBe(true));
  it("«друзья» — только друзьям", () => {
    expect(canSee(2, { id: 1, visibility: "friends" }, "friends")).toBe(true);
    expect(canSee(2, { id: 1, visibility: "friends" }, "incoming")).toBe(false);
  });
  it("«только я» — никому", () => expect(canSee(2, { id: 1, visibility: "private" }, "friends")).toBe(false));
});

describe("friendState", () => {
  it("нет строки — нет связи", () => expect(friendState(1, [])).toBe("none"));
  it("направление заявки", () => {
    expect(friendState(1, [{ from_id: 1, to_id: 2, status: "pending" }])).toBe("outgoing");
    expect(friendState(2, [{ from_id: 1, to_id: 2, status: "pending" }])).toBe("incoming");
  });
  it("принята — друзья с обеих сторон", () => expect(friendState(2, [{ from_id: 1, to_id: 2, status: "accepted" }])).toBe("friends"));
});

describe("watchMinutes", () => {
  it("серии × длительность", () => expect(watchMinutes({ episodes: 10, status: "watching" }, { episodes: 12, duration: 24 })).toBe(240));
  it("не больше числа серий", () => expect(watchMinutes({ episodes: 30, status: "completed" }, { episodes: 12, duration: 20 })).toBe(240));
  it("просмотренный фильм без отметки серий", () => expect(watchMinutes({ episodes: 0, status: "completed" }, { episodes: 1, duration: 110 })).toBe(110));
  it("без длительности — 24 мин", () => expect(watchMinutes({ episodes: 2, status: "watching" }, { episodes: null, duration: null })).toBe(48));
});
