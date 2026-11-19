import { describe, expect, it } from "vitest";
import { aiCref, assemble, parseAiCref, segments } from "./book-translate";
import type { Block } from "./books";

const p = (text: string): Block => ({ t: "p", text });

describe("автоперевод главы", () => {
  it("куски по размеру, картинка — на своём месте", () => {
    const blocks: Block[] = [p("a".repeat(30)), p("b".repeat(30)), { t: "img", url: "x.jpg" }, p("c".repeat(30)), p(" ")];
    const segs = segments(blocks, 50);
    expect(segs.map((s) => (s.t === "text" ? s.paras.length : "img"))).toEqual([1, 1, "img", 1]);
    const out = assemble(segs, ["А", "Б\n\nБ2", "В"]);
    expect(out).toEqual([p("А"), p("Б"), p("Б2"), { t: "img", url: "x.jpg" }, p("В")]);
  });
  it("абзацы без пустых строк — по переводам строк", () => {
    expect(assemble([{ t: "text", paras: ["x", "y"] }], ["Икс\nИгрек"])).toEqual([p("Икс"), p("Игрек")]);
  });
  it("cref ИИ туда и обратно (ключ книжного издания с дефисом)", () => {
    expect(parseAiCref(aiCref("book", "2-5"))).toEqual({ edition: "book", key: "2-5" });
  });
});
