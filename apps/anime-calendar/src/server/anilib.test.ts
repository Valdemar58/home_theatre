import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { decide, parseProfile } = await import("./anilib");

const v = (status: string | null, episodes: number | null, score: number | null) =>
  ({ status, episodes, score }) as Parameters<typeof decide>[0];

describe("decide: слияние AniLib → календарь (главнее календарь)", () => {
  it("нет в календаре: добавить; удалено после прошлой синхронизации — не возвращать", () => {
    expect(decide(v("watching", 3, null), null, null).action).toBe("add");
    expect(decide(v("watching", 3, null), null, v("watching", 3, null)).action).toBe("removed");
  });

  it("первая встреча: пустое заполняем, разное — конфликт в пользу календаря", () => {
    // оценка 8 на AniLib, в календаре без оценки
    expect(decide(v("completed", null, 8), v("completed", 12, 0), null)).toMatchObject({ action: "update", fields: ["score"] });
    // статус отличается: календарь главнее
    expect(decide(v("watching", 5, null), v("completed", 12, 0), null)).toMatchObject({ action: "conflict", conflicts: ["status"] });
  });

  it("со снимком: изменилось только на AniLib — применяем", () => {
    const snap = v("watching", 3, null);
    expect(decide(v("watching", 5, null), v("watching", 3, 0), snap)).toMatchObject({ action: "update", fields: ["episodes"] });
    expect(decide(v("dropped", 5, 4), v("watching", 3, 0), snap)).toMatchObject({ fields: ["status", "episodes", "score"] });
  });

  it("со снимком: изменилось только в календаре — не трогаем", () => {
    expect(decide(v("watching", 3, null), v("watching", 7, 9), v("watching", 3, null)).action).toBe("same");
  });

  it("со снимком: изменилось в обоих — конфликт, остаётся как в календаре", () => {
    expect(decide(v("watching", 5, null), v("watching", 7, 0), v("watching", 3, null)))
      .toMatchObject({ action: "conflict", conflicts: ["episodes"], fields: [] });
  });

  it("у просмотренного число серий не сравниваем; неизвестное на AniLib пропускаем", () => {
    expect(decide(v("completed", 3, null), v("completed", 12, 0), null).action).toBe("same");
    expect(decide(v(null, null, null), v("watching", 3, 7), null).action).toBe("same");
  });
});

describe("parseProfile", () => {
  it("ссылка, ссылка с параметрами, число", () => {
    expect(parseProfile("https://v5.animelib.org/ru/user/7392528?page=1&sort_by=name")).toBe(7392528);
    expect(parseProfile("https://anilib.me/user/42")).toBe(42);
    expect(parseProfile(" 7392528 ")).toBe(7392528);
    expect(parseProfile("v4ldem4r")).toBeNull();
  });
});
