import { describe, expect, it } from "vitest";
import { formatAiring, formatDate, relative, tzLabel } from "./time";

// Пятница, 9 октября 2026, 14:00 UTC = 17:00 по Москве
const FRI = Date.UTC(2026, 9, 9, 14, 0) / 1000;

describe("formatAiring", () => {
  it("день недели, дата, время и метка МСК", () => {
    expect(formatAiring(FRI, "Europe/Moscow")).toMatchObject({
      weekday: "пятница", date: "9 октября", time: "17:00", tz: "МСК", full: "пятница, 9 октября, 17:00 МСК",
    });
  });

  it("другой пояс: сдвиг относительно Москвы и смена дня", () => {
    // 14:00 UTC = 23:00 в Токио, ещё пятница
    expect(formatAiring(FRI, "Asia/Tokyo")).toMatchObject({ weekday: "пятница", time: "23:00", tz: "МСК+6" });
    // 20:00 UTC в субботу по Новосибирску (+7) — уже воскресенье 03:00
    expect(formatAiring(Date.UTC(2026, 9, 10, 20, 0) / 1000, "Asia/Novosibirsk")).toMatchObject({ weekday: "воскресенье", time: "03:00", tz: "МСК+4" });
  });
});

describe("tzLabel и летнее время", () => {
  it("Нью-Йорк летом МСК−7, зимой МСК−8", () => {
    expect(tzLabel(Date.UTC(2026, 6, 1) / 1000, "America/New_York")).toBe("МСК−7");
    expect(tzLabel(Date.UTC(2026, 11, 1) / 1000, "America/New_York")).toBe("МСК−8");
  });
  it("получасовые пояса", () => {
    expect(tzLabel(FRI, "Asia/Kolkata")).toBe("МСК+2.5");
  });
});

describe("relative", () => {
  it("будущее и прошлое", () => {
    const now = FRI * 1000;
    expect(relative(FRI + 4 * 86400 + 3 * 3600, now)).toBe("через 4 д 3 ч");
    expect(relative(FRI - 25 * 60, now)).toBe("25 мин назад");
  });

  it("доли секунды: не уходит в отрицательные годы", () => {
    const now = FRI * 1000 + 400;
    expect(relative(FRI, now)).toBe("через 1 мин");
  });

  it("меньше месяца — дни и часы", () => {
    const now = FRI * 1000;
    expect(relative(FRI - 29 * 86400 - 5 * 3600, now)).toBe("29 д 5 ч назад");
  });

  it("от месяца — месяцы и дни, без часов", () => {
    const now = FRI * 1000;
    // 9 октября → 9 июня того же года: ровно 4 месяца
    expect(relative(Date.UTC(2026, 5, 9, 14, 0) / 1000, now)).toBe("4 мес назад");
    expect(relative(Date.UTC(2026, 5, 2, 10, 0) / 1000, now)).toBe("4 мес 7 д назад");
    expect(relative(FRI + 40 * 86400, now)).toBe("через 1 мес 9 д");
  });

  it("от года — годы, месяцы и дни; нулевые части не пишем", () => {
    const now = FRI * 1000;
    // «2928 д 1 ч назад» из IDEAS.md: 8 лет (2922 д с двумя високосными) и 6 д
    expect(relative(FRI - 2928 * 86400 - 3600, now)).toBe("8 лет 6 д назад");
    expect(relative(Date.UTC(2025, 6, 1, 12, 0) / 1000, now)).toBe("1 год 3 мес 8 д назад");
    expect(relative(Date.UTC(2023, 9, 9, 14, 0) / 1000, now)).toBe("3 года назад");
  });
});

describe("год в датах", () => {
  const now = FRI * 1000;
  it("текущий год не пишем, другой — пишем", () => {
    expect(formatDate(FRI - 86400, false, now)).toBe("8 октября");
    expect(formatDate(Date.UTC(2024, 2, 5, 12) / 1000, false, now)).toBe("5 марта 2024 г.");
    expect(formatAiring(Date.UTC(2018, 9, 5, 14) / 1000, "Europe/Moscow", now).date).toBe("5 октября 2018 г.");
    expect(formatAiring(FRI, "Europe/Moscow", now).date).toBe("9 октября");
  });
});
