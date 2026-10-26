import { describe, expect, it } from "vitest";
import { extractJson, matchEnum, schemaPrompt, validate, type JsonSchema } from "./json-lite";
import { parseTaskPools } from "./llm-tasks";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    tone: { type: "string", enum: ["серьёзный", "комедийный", "трэш/абсурд"], synonyms: { "дичь": "трэш/абсурд" } },
    humor: { type: "array", items: { type: "string", enum: ["нет", "пародия", "абсурдный"] }, maxItems: 2 },
    complexity: { type: "integer", minimum: 1, maximum: 5 },
    note: { type: "string" },
  },
  required: ["tone", "humor", "complexity"],
};

describe("проверка ответа LLM по схеме", () => {
  it("enum: регистр, ё, кавычки, общее начало слова, синонимы", () => {
    expect(matchEnum("Серьезный", ["серьёзный"])).toBe("серьёзный");
    expect(matchEnum("«комедия»", ["серьёзный", "комедийный"])).toBe("комедийный");
    expect(matchEnum("дичь", ["трэш/абсурд"], { "дичь": "трэш/абсурд" })).toBe("трэш/абсурд");
    expect(matchEnum("романтика", ["серьёзный", "комедийный"])).toBeNull();
  });

  it("приводит числа к границам, обрезает массивы, выбрасывает чужие значения", () => {
    const v = validate(SCHEMA, { tone: "КОМЕДИЙНЫЙ", humor: ["пародия", "кринж", "абсурдный", "нет"], complexity: "7.4", extra: 1 });
    expect(v).toEqual({ ok: true, value: { tone: "комедийный", humor: ["пародия", "абсурдный"], complexity: 5 } });
  });

  it("ошибка, если обязательное поле отсутствует или не сопоставилось", () => {
    const v = validate(SCHEMA, { tone: "грустный", humor: [] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/tone.*complexity|complexity.*tone/s);
  });

  it("достаёт JSON из markdown-обёртки и текста вокруг", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Вот ответ: {"a":2} — готово')).toEqual({ a: 2 });
    expect(() => extractJson("нет json")).toThrow();
  });

  it("описание схемы для промпта", () => {
    const p = schemaPrompt(SCHEMA);
    expect(p).toContain('"tone": "серьёзный" | "комедийный" | "трэш/абсурд"');
    expect(p).toContain('"complexity": integer 1–5');
    expect(p).toContain('"note"?: string');
  });

  it("пулы задач из .env", () => {
    const p = parseTaskPools("recap:smart, rerank , bogus:smart, tags:nope");
    expect(p.recap).toBe("smart");
    expect(p.rerank).toBe("cheap");
    expect(p.tags).toBe("local");
    expect(p.analysis).toBe("local");
  });
});
