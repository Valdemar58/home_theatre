// Проверка ответа LLM по JSON-схеме (подмножество) с мягким приведением.
// Ollama соблюдает схему почти всегда, внешний API в JSON-режиме — только форму «объект»,
// поэтому ответ любой модели приводится к схеме: регистр и «ё» в enum, синонимы, границы чисел.

export type JsonSchema = {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  /** Синонимы для enum: вариант модели → значение схемы (нормализованные ключи) */
  synonyms?: Record<string, string>;
};

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const norm = (s: string) =>
  s.toLowerCase().replace(/ё/g, "е").replace(/["'«»`.!]/g, "").replace(/\s+/g, " ").trim();

/** Значение enum по ответу модели: точное → синоним → общее начало слова (не короче 5 букв). */
export function matchEnum(raw: string, values: string[], synonyms?: Record<string, string>): string | null {
  const n = norm(raw);
  const exact = values.find((v) => norm(v) === n);
  if (exact) return exact;
  const syn = synonyms?.[n];
  if (syn && values.includes(syn)) return syn;
  const byPrefix = values.filter((v) => {
    const m = norm(v);
    let i = 0;
    while (i < m.length && i < n.length && m[i] === n[i]) i++;
    return i >= Math.min(5, m.length, n.length) && i > 0;
  });
  return byPrefix.length === 1 ? byPrefix[0] : null;
}

/** Убрать markdown-обёртку и лишний текст вокруг JSON-объекта. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("ответ не JSON");
  }
}

function coerce(s: JsonSchema, v: unknown, path: string, errors: string[]): unknown {
  switch (s.type) {
    case "object": {
      // Объект, завёрнутый в массив из одного элемента («[{…}]»), — тот же объект
      if (Array.isArray(v) && v.length === 1) v = v[0];
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${path || "ответ"}: нужен объект`);
        return undefined;
      }
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        if (src[k] === undefined || src[k] === null) {
          if (s.required?.includes(k)) errors.push(`${path}${k}: нет поля`);
          continue;
        }
        const c = coerce(sub, src[k], `${path}${k}.`, errors);
        if (c !== undefined) out[k] = c;
        else if (s.required?.includes(k)) errors.push(`${path}${k}: неверное значение`);
      }
      return out;
    }
    case "array": {
      const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : null;
      if (!arr) return undefined;
      // Неподходящие элементы выбрасываются, а не валят весь ответ
      // Элемент без обязательного поля (или с неверным) тоже неподходящий: иначе дальше уходит объект с дырой
      const items = arr.map((x, i) => {
        if (!s.items) return x;
        const errs: string[] = [];
        const c = coerce(s.items, x, `${path}${i}.`, errs);
        return errs.length ? undefined : c;
      }).filter((x) => x !== undefined);
      const capped = s.maxItems ? items.slice(0, s.maxItems) : items;
      if (s.minItems && capped.length < s.minItems) return undefined;
      return capped;
    }
    case "string": {
      if (typeof v !== "string" && typeof v !== "number") return undefined;
      const str = String(v).replace(/\*\*|__/g, "").trim();
      if (s.enum) return matchEnum(str, s.enum, s.synonyms) ?? undefined;
      return str;
    }
    case "integer":
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      if (!Number.isFinite(n)) return undefined;
      let x = s.type === "integer" ? Math.round(n) : n;
      if (s.minimum !== undefined) x = Math.max(s.minimum, x);
      if (s.maximum !== undefined) x = Math.min(s.maximum, x);
      return x;
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    default:
      return v;
  }
}

export function validate<T>(schema: JsonSchema, value: unknown): Validated<T> {
  const errors: string[] = [];
  const out = coerce(schema, value, "", errors);
  return errors.length || out === undefined ? { ok: false, errors: errors.length ? errors : ["неверный ответ"] } : { ok: true, value: out as T };
}

function render(s: JsonSchema, indent: string): string {
  const note = (x: JsonSchema) => {
    const parts = [x.description, x.minItems || x.maxItems ? `${x.minItems ?? 0}–${x.maxItems ?? "∞"} шт.` : ""].filter(Boolean);
    return parts.length ? ` /* ${parts.join("; ")} */` : "";
  };
  switch (s.type) {
    case "object": {
      const inner = Object.entries(s.properties ?? {}).map(([k, sub]) => {
        const opt = s.required?.includes(k) ? "" : "?";
        return `${indent}  "${k}"${opt}: ${render(sub, `${indent}  `)}${note(sub)}`;
      });
      return `{\n${inner.join(",\n")}\n${indent}}`;
    }
    case "array":
      return `${s.items ? render(s.items, indent) : "any"}[]`;
    case "string":
      return s.enum ? s.enum.map((e) => JSON.stringify(e)).join(" | ") : "string";
    case "integer":
    case "number":
      return `${s.type === "integer" ? "integer" : "number"}${s.minimum !== undefined ? ` ${s.minimum}–${s.maximum}` : ""}`;
    default:
      return s.type ?? "any";
  }
}

/** Компактное описание схемы для промпта модели без поддержки JSON-схем. */
export function schemaPrompt(schema: JsonSchema): string {
  return `Ответь только JSON-объектом ровно такой формы (? — необязательное поле):\n${render(schema, "")}`;
}
