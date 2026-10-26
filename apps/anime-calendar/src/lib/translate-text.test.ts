import { describe, expect, it } from "vitest";
import { chunkText, glossaryFor } from "./translate-text";

describe("chunkText", () => {
  it("короткий текст — один кусок, абзацы сохраняются", () => {
    expect(chunkText("A.\nB.", 100)).toEqual(["A.\n\nB."]);
  });

  it("режет по абзацам, не длиннее предела", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n");
    const chunks = chunkText(text, 700);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 700)).toBe(true);
    expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("длинный абзац — по предложениям", () => {
    const p = "Subaru runs. ".repeat(100);
    const chunks = chunkText(p, 300);
    expect(chunks.every((c) => c.length <= 300 && c.endsWith("."))).toBe(true);
  });
});

describe("glossaryFor", () => {
  const entries = [
    { names: ["Subaru Natsuki", "ナツキ・スバル"], ru: "Субару Нацуки" },
    { names: ["Emilia", "エミリア"], ru: "Эмилия" },
    { names: ["Rem", "レム"], ru: "Рем" },
  ];

  it("берёт имена из текста, в том числе по части имени", () => {
    expect(glossaryFor("Subaru meets Emilia at the market.", entries)).toEqual([
      "Subaru Natsuki / ナツキ・スバル = Субару Нацуки",
      "Emilia / エミリア = Эмилия",
    ]);
  });

  it("по целому слову: «Rem» не находится в «remains»", () => {
    expect(glossaryFor("Nothing remains.", entries)).toEqual([]);
    expect(glossaryFor("Rem smiles.", entries)).toEqual(["Rem / レム = Рем"]);
  });

  it("японский текст", () => {
    expect(glossaryFor("スバルはエミリアに出会う", entries)).toHaveLength(2);
  });
});
