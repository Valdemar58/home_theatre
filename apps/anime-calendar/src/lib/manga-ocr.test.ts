import { describe, expect, it } from "vitest";
import { bubbles, fitFont } from "./manga-ocr";

describe("пузыри манги", () => {
  it("вертикальные колонки одного пузыря — справа налево", () => {
    const b = bubbles([
      { text: "いくぞ", x0: 100, y0: 10, x1: 120, y1: 80 },
      { text: "おれが", x0: 124, y0: 10, x1: 144, y1: 80 },
      { text: "遠くの", x0: 400, y0: 10, x1: 420, y1: 80 },
    ]);
    expect(b).toHaveLength(2);
    expect(b.find((x) => x.x0 === 100)).toMatchObject({ text: "おれがいくぞ", vertical: true, x1: 144 });
  });
  it("горизонтальные строки — сверху вниз, далёкая строка — отдельно", () => {
    const b = bubbles([
      { text: "WHAT ARE", x0: 50, y0: 100, x1: 150, y1: 116 },
      { text: "YOU DOING?", x0: 45, y0: 120, x1: 155, y1: 136 },
      { text: "HEY", x0: 600, y0: 500, x1: 640, y1: 516 },
      { text: "...", x0: 0, y0: 0, x1: 10, y1: 10 },
    ]);
    expect(b.map((x) => x.text)).toEqual(["WHAT ARE YOU DOING?", "HEY"]);
  });
  it("крупное звукоподражание не липнет к реплике", () => {
    const b = bubbles([
      { text: "HEY YOU", x0: 50, y0: 100, x1: 150, y1: 116 },
      { text: "BOOM", x0: 60, y0: 118, x1: 260, y1: 178 },
    ]);
    expect(b).toHaveLength(2);
  });
  it("номер страницы и одиночная буква — не пузыри", () => {
    expect(bubbles([{ text: "633", x0: 0, y0: 0, x1: 30, y1: 14 }, { text: "H", x0: 300, y0: 300, x1: 310, y1: 314 }, { text: "え", x0: 500, y0: 500, x1: 514, y1: 514 }]).map((b) => b.text)).toEqual(["え"]);
  });
  it("шрифт — в пределах пузыря", () => {
    const s = fitFont("Привет, как дела?", 120, 60);
    expect(s).toBeGreaterThanOrEqual(8);
    expect(s).toBeLessThanOrEqual(54);
  });
});
