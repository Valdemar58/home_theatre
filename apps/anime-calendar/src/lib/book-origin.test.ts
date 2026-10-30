import { describe, expect, it } from "vitest";
import { muStatusChapters, muStatusRu } from "./book-origin";

describe("статус MangaUpdates по-русски", () => {
  it("тома и главы, состояние, склонение", () => {
    expect(muStatusRu("32 Volumes (Ongoing)")).toBe("32 тома, выходит");
    expect(muStatusRu("21 Volumes (Complete)")).toBe("21 том, завершена");
    expect(muStatusRu("150 Chapters (Hiatus)")).toBe("150 глав, перерыв");
    expect(muStatusRu("1 Volume (Complete)")).toBe("1 том, завершена");
  });
  it("несколько строк — основная; пусто — null", () => {
    expect(muStatusRu("10 Volumes (Complete)\n2 Volumes (Side Story)")).toBe("10 томов, завершена");
    expect(muStatusRu("")).toBeNull();
    expect(muStatusRu("Ongoing")).toBe("Ongoing");
  });
  it("число глав из статуса", () => {
    expect(muStatusChapters("150 Chapters (Ongoing)")).toBe(150);
    expect(muStatusChapters("32 Volumes (Ongoing)")).toBeNull();
  });
});
