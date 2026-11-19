import { describe, expect, it } from "vitest";
import { INVITE_LIMIT, inviteLimitReached, safeNext } from "./accounts";

describe("safeNext", () => {
  it("свой путь — как есть", () => {
    expect(safeNext("/anime/1/watch/2?room=x")).toBe("/anime/1/watch/2?room=x");
  });
  it("чужой сайт и пустое — в календарь", () => {
    for (const bad of [
      "/\n/evil.example",
      "/\t/evil.example",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "evil",
      "",
      null,
      undefined,
    ]) {
      expect(safeNext(bad)).toBe("/calendar");
    }
  });
});

describe("inviteLimitReached", () => {
  it("лимит действующих приглашений", () => {
    expect(inviteLimitReached(INVITE_LIMIT - 1)).toBe(false);
    expect(inviteLimitReached(INVITE_LIMIT)).toBe(true);
  });
});
