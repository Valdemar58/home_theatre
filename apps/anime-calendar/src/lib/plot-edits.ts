import { slug, type Graph } from "./plot-graph";

// Правки графа сюжета (IDEAS #81, этап 1 — админ, персонаж). Правка — отдельный слой поверх графа модели: хранится
// своей строкой (plot_edit) и накладывается на свёрнутый граф при каждой записи в таблицы, поэтому переживает
// пересборку, а ответы модели не трогает. У правки — серия, с которой это известно (иначе правка — спойлер).

export const EDIT_KINDS = ["anilist", "same", "split", "name", "note", "image"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export const EDIT_LABELS: Record<EditKind, string> = {
  anilist: "Персонаж AniList", same: "Одно лицо", split: "Разные люди", name: "Имя", note: "Описание", image: "Картинка",
};

export type EditData = {
  anilist: { charId: number };
  same: { other: string; note?: string };
  split: { other: string };
  name: { name: string };
  note: { description: string; goal?: string };
  image: { url: string; label?: string };
};

/** Правка: key — ключ персонажа во франшизе (plot_key), anilistId — тайтл, к серии которого относится from_ep. */
export type PlotEdit = { [K in EditKind]: { id: number; key: string; anilistId: number; kind: K; data: EditData[K]; fromEp: number } }[EditKind];

/** Проверка ввода: чего не хватает — текстом для ответа 400; null — всё в порядке. */
export function editProblem(kind: string, data: unknown, fromEp: number): string | null {
  if (!EDIT_KINDS.includes(kind as EditKind)) return "Неизвестный вид правки";
  if (!Number.isInteger(fromEp) || fromEp < 0) return "Серия — целое число от 0";
  const d = (data ?? {}) as Record<string, unknown>;
  const text = (k: string, max: number) => typeof d[k] === "string" && (d[k] as string).trim().length > 0 && (d[k] as string).length <= max;
  switch (kind as EditKind) {
    case "anilist": return Number.isInteger(d.charId) && (d.charId as number) >= 0 ? null : "Нужен персонаж AniList (0 — не связан)";
    case "same": case "split": return text("other", 200) ? null : "Нужен второй персонаж";
    case "name": return text("name", 120) ? null : "Нужно имя (до 120 знаков)";
    case "note": return text("description", 2000) ? null : "Нужно описание (до 2000 знаков)";
    case "image": return text("url", 1000) && /^https:\/\//.test(d.url as string) ? null : "Нужна ссылка на картинку (https)";
  }
}

const pair = (a: string, b: string) => [a, b].sort().join("|");

/**
 * Наложить правки на свёрнутый граф франшизы (после сверки: её вход от правок не меняется, ответ не пересчитывается).
 * same — склейки сверки; anilist — привязки сверки к AniList. Возвращает привязки с правками: 0 — «не связан».
 * Порядок — по id: поздняя правка того же вида главнее.
 */
export function applyEdits(g: Graph, edits: PlotEdit[], same: Graph["identities"], anilist: Map<string, number>): { same: Graph["identities"]; anilist: Map<string, number> } {
  const links = new Map(anilist);
  let glued = [...same];
  for (const e of [...edits].sort((a, b) => a.id - b.id)) {
    const key = slug(e.key);
    const p = g.personas.get(key);
    if (!p) continue;
    switch (e.kind) {
      case "anilist":
        links.set(key, e.data.charId);
        break;
      case "same": {
        const other = slug(e.data.other);
        if (other === key || !g.personas.has(other)) break;
        const k = pair(key, other);
        g.identities = g.identities.filter((i) => pair(i.a, i.b) !== k);
        glued = glued.filter((i) => pair(i.a, i.b) !== k);
        g.identities.push({ a: key, b: other, ep: e.fromEp, note_ru: e.data.note ?? "", revealed: e.fromEp, title: e.anilistId });
        break;
      }
      case "split": {
        const k = pair(key, slug(e.data.other));
        g.identities = g.identities.filter((i) => pair(i.a, i.b) !== k);
        glued = glued.filter((i) => pair(i.a, i.b) !== k);
        break;
      }
      case "name": {
        const name = e.data.name.trim();
        // Имя с той же серии того же тайтла заменяется; более поздние смены имени модели остаются
        g.names = g.names.filter((n) => !(n.key === key && n.title === e.anilistId && n.from === e.fromEp));
        g.names.push({ key, name_ru: name, from: e.fromEp, title: e.anilistId });
        const later = g.names.some((n) => n.key === key && (n.title > e.anilistId || (n.title === e.anilistId && n.from > e.fromEp)));
        // Последнее имя ленты — основное имя сущности
        if (!later) p.name_ru = name;
        break;
      }
      case "note":
        // С этой серии — описание из правки вместо описаний модели (до следующей правки)
        g.notes = g.notes.filter((n) => !(n.key === key && n.title === e.anilistId && n.upTo >= e.fromEp));
        g.notes.push({ key, from: e.fromEp, upTo: e.fromEp, description_ru: e.data.description.trim(), goal_ru: (e.data.goal ?? "").trim(), title: e.anilistId });
        break;
      case "image":
        // Картинка пишется в plot_image сразу при правке — в граф не входит
        break;
    }
  }
  return { same: glued, anilist: links };
}
