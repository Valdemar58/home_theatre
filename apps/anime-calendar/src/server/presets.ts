import "server-only";
import type { FilterPreset } from "@/lib/types";
import { db, now } from "./db";
import { ApiError } from "./route";

// Свои наборы фильтров каталога: имя + параметры адреса (фильтры и сортировка); один — «по умолчанию».

type Row = { id: number; name: string; query: string; is_default: number };

const clean = (q: string) => {
  const p = new URLSearchParams(q);
  // Поиск и страница — не часть набора
  p.delete("q");
  p.delete("page");
  p.sort();
  return p.toString();
};

export function listPresets(userId: number): FilterPreset[] {
  return db.prepare<[number], Row>("SELECT id, name, query, is_default FROM filter_presets WHERE user_id = ? ORDER BY position, id").all(userId)
    .map((r) => ({ id: r.id, name: r.name, query: r.query, isDefault: Boolean(r.is_default) }));
}

export function savePreset(userId: number, p: { id?: number; name?: string; query?: string; isDefault?: boolean }) {
  const name = p.name?.trim().slice(0, 40);
  if (p.id) {
    const own = db.prepare<[number, number], { id: number }>("SELECT id FROM filter_presets WHERE id = ? AND user_id = ?").get(p.id, userId);
    if (!own) throw new ApiError(404, "Набор не найден");
    if (name) db.prepare("UPDATE filter_presets SET name = ? WHERE id = ?").run(name, p.id);
    if (p.query !== undefined) db.prepare("UPDATE filter_presets SET query = ? WHERE id = ?").run(clean(p.query), p.id);
  } else {
    if (!name) throw new ApiError(400, "Нужно название");
    const pos = db.prepare<[number], { n: number }>("SELECT COALESCE(MAX(position), 0) + 1 n FROM filter_presets WHERE user_id = ?").get(userId)!.n;
    p.id = Number(db.prepare("INSERT INTO filter_presets (user_id, name, query, position, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, name, clean(p.query ?? ""), pos, now()).lastInsertRowid);
  }
  if (p.isDefault !== undefined) {
    db.prepare("UPDATE filter_presets SET is_default = 0 WHERE user_id = ?").run(userId);
    if (p.isDefault) db.prepare("UPDATE filter_presets SET is_default = 1 WHERE id = ?").run(p.id);
  }
  return listPresets(userId);
}

export function deletePreset(userId: number, id: number) {
  db.prepare("DELETE FROM filter_presets WHERE id = ? AND user_id = ?").run(id, userId);
  return listPresets(userId);
}
