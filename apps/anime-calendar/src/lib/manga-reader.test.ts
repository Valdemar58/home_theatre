import { describe, expect, it } from "vitest";
import { MANGA_DEFAULTS, mangaSettings, mangaKey, tapAction } from "./manga-reader";

describe("manga navigation", () => {
  it("migrates old settings and rejects corrupt local storage values", () => {
    expect(mangaSettings({ mode: "strip", dir: "ltr", stripWidth: 60 }).swipe).toBe(true);
    expect(mangaSettings({ gap: -10, stripWidth: Infinity, taps: "invalid" as never })).toMatchObject({ gap: 0, stripWidth: 48, taps: "direction" });
  });
  it("supports directional taps, fixed sides and buttons only", () => {
    expect(tapAction(0.1, MANGA_DEFAULTS)).toBe("next");
    expect(tapAction(0.9, MANGA_DEFAULTS)).toBe("previous");
    expect(tapAction(0.1, { taps: "physical", dir: "rtl" })).toBe("previous");
    expect(tapAction(0.9, { taps: "off", dir: "ltr" })).toBeNull();
    expect(tapAction(0.5, { taps: "off", dir: "rtl" })).toBe("controls");
  });
  it("respects RTL arrows and reverse space navigation", () => {
    expect(mangaKey("ArrowLeft", false, "rtl")).toBe("next");
    expect(mangaKey("ArrowLeft", false, "ltr")).toBe("previous");
    expect(mangaKey(" ", true, "rtl")).toBe("previous");
    expect(mangaKey("PageDown", false, "rtl")).toBe("next");
  });
});
