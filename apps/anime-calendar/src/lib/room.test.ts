import { describe, expect, it } from "vitest";
import { canControl, clockOffset, correction, netTone, positionAt } from "./room";

describe("комната совместного просмотра", () => {
  it("позиция идёт только во время просмотра", () => {
    expect(positionAt({ playing: true, pos: 100, at: 1_000 }, 4_500)).toBe(103.5);
    expect(positionAt({ playing: false, pos: 100, at: 1_000 }, 4_500)).toBe(100);
    // Часы клиента отстали от отметки — назад не уходим
    expect(positionAt({ playing: true, pos: 100, at: 5_000 }, 4_500)).toBe(100);
  });
  it("управление: все равны — любой вошедший, организатор — он и те, кому дал право", () => {
    const m = (o: Partial<{ host: boolean; control: boolean; status: "invited" | "joined" | "left" }>) => ({ host: false, control: false, status: "joined" as const, ...o });
    expect(canControl("equal", m({}))).toBe(true);
    expect(canControl("equal", m({ status: "invited" }))).toBe(false);
    expect(canControl("host", m({}))).toBe(false);
    expect(canControl("host", m({ control: true }))).toBe(true);
    expect(canControl("host", m({ host: true }))).toBe(true);
    expect(canControl("host", undefined)).toBe(false);
  });
  it("поправка: мелочь — ничего, среднее — скоростью, большое — перемоткой", () => {
    expect(correction(0.1, true)).toEqual({ seek: false, rate: 1 });
    expect(correction(1, true)).toEqual({ seek: false, rate: 0.95 });
    expect(correction(-0.5, true)).toEqual({ seek: false, rate: 1.025 });
    expect(correction(-3, true)).toEqual({ seek: true, rate: 1 });
    expect(correction(0.4, false)).toEqual({ seek: false, rate: 1 });
    expect(correction(0.8, false)).toEqual({ seek: true, rate: 1 });
  });
  it("часы сервера — по середине запроса", () => {
    expect(clockOffset(1_000, 1_200, 6_100)).toBe(5_000);
  });
  it("связь", () => {
    expect(netTone({ bw: 20e6, rtt: 40 })).toBe("positive");
    expect(netTone({ bw: 3e6, rtt: 40 })).toBe("warning");
    expect(netTone({ bw: 20e6, rtt: 900 })).toBe("negative");
    expect(netTone(null)).toBe("neutral");
  });
});
