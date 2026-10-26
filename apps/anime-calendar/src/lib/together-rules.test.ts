import { describe, expect, it } from "vitest";
import { defaultUpTo, episodesRange, togetherChange } from "./together-rules";

describe("togetherChange", () => {
  it("подтягивает до серии N", () => expect(togetherChange({ userId: 1, status: "watching", episodes: 3 }, 8, 24)).toEqual({ from: 3, to: 8 }));
  it("нет в списке — с нуля", () => expect(togetherChange({ userId: 1, status: null, episodes: 0 }, 2, 12)).toEqual({ from: 0, to: 2 }));
  it("не откатывает ушедшего дальше", () => expect(togetherChange({ userId: 1, status: "watching", episodes: 10 }, 8, 24)).toBeNull());
  it("досмотревшего не трогает", () => expect(togetherChange({ userId: 1, status: "completed", episodes: 12 }, 12, 12)).toBeNull());
  it("не больше числа серий", () => expect(togetherChange({ userId: 1, status: "watching", episodes: 10 }, 30, 12)).toEqual({ from: 10, to: 12 }));
});

describe("defaultUpTo", () => {
  it("все на одной серии — следующая", () => expect(defaultUpTo([{ userId: 1, status: "watching", episodes: 5 }, { userId: 2, status: "watching", episodes: 5 }], 12)).toBe(6));
  it("кто-то впереди — до него", () => expect(defaultUpTo([{ userId: 1, status: "watching", episodes: 8 }, { userId: 2, status: null, episodes: 0 }], 12)).toBe(8));
  it("не больше числа серий", () => expect(defaultUpTo([{ userId: 1, status: "watching", episodes: 12 }], 12)).toBe(12));
});

describe("episodesRange", () => {
  it("одна серия", () => expect(episodesRange(4, 5)).toBe("серия 5"));
  it("несколько", () => expect(episodesRange(3, 8)).toBe("серии 4–8"));
});
