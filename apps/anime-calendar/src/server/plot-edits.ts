import "server-only";
import { editProblem, type EditKind, type PlotEdit } from "@/lib/plot-edits";
import type { PlotEditor } from "@/lib/types";
import { getDetails } from "./anilist";
import { db, now } from "./db";
import { ApiError } from "./route";
import { titleCharacters } from "./plot-graph";
import type { User } from "./session";

// Правки графа сюжета людьми (IDEAS #81, этап 1 — админ, персонаж): хранятся в plot_edit, накладываются при записи
// графа (materializeGraph → lib/plot-edits.ts applyEdits); после правки и отмены граф тайтла перезаписывается сразу —
// без модели, сверка берётся из журнала. Картинка — строка plot_image (source = 'manual'), в граф не входит.

type Row = { id: number; root_id: number; key: string; anilist_id: number; kind: EditKind; data: string; from_ep: number; user_id: number; created_at: number; undone_at: number | null };

const toEdit = (r: Row) => ({ id: r.id, key: r.key, anilistId: r.anilist_id, kind: r.kind, data: JSON.parse(r.data), fromEp: r.from_ep }) as PlotEdit;

/** Действующие правки франшизы (по порядку внесения). */
export const activeEdits = (root: number): PlotEdit[] =>
  db.prepare<[number], Row>("SELECT * FROM plot_edit WHERE root_id = ? AND undone_at IS NULL ORDER BY id").all(root).map(toEdit);

/** Ключ сущности во франшизе тайтла: корень — первый сезон цепочки предысторий. */
async function target(entityId: number, anilistId: number): Promise<{ root: number; key: string }> {
  const { titleGraph } = await import("./plot-graph-build");
  const { root } = await titleGraph(anilistId);
  const k = db.prepare<[number, number], { key: string }>("SELECT key FROM plot_key WHERE root_id = ? AND entity_id = ? ORDER BY key").get(root, entityId);
  if (!k) throw new ApiError(404, "Персонажа нет в разборе серий этого тайтла — править нечего");
  return { root, key: k.key };
}

/** Перезаписать граф тайтлов, которых касается правка: привязка к AniList — всех разобранных сезонов франшизы. */
async function rewrite(root: number, kind: EditKind, anilistId: number) {
  if (kind === "image") return;
  const { materializeGraph } = await import("./plot-graph-build");
  const titles = kind === "anilist"
    ? db.prepare<[number], { anilist_id: number }>(`SELECT DISTINCT a.anilist_id FROM plot_appearance a JOIN plot_title t ON t.anilist_id = a.anilist_id
        WHERE a.entity_id IN (SELECT entity_id FROM plot_key WHERE root_id = ?)`).all(root).map((r) => r.anilist_id)
    : [anilistId];
  for (const id of titles) if (db.prepare("SELECT 1 FROM plot_title WHERE anilist_id = ?").get(id)) await materializeGraph(id);
}

/** Сущность ключа сейчас (после перезаписи графа у ключа может быть другая сущность). */
const entityOfKey = (root: number, key: string) => db.prepare<[number, string], { entity_id: number }>("SELECT entity_id FROM plot_key WHERE root_id = ? AND key = ?").get(root, key)?.entity_id ?? null;

export async function addEdit(user: User, body: { entityId: number; anilistId: number; kind: string; data: unknown; fromEp: number }): Promise<{ id: number; href: string | null }> {
  const problem = editProblem(body.kind, body.data, body.fromEp);
  if (problem) throw new ApiError(400, problem);
  const { root, key } = await target(body.entityId, body.anilistId);
  const kind = body.kind as EditKind;
  const data = body.data as Record<string, unknown>;
  // Второй персонаж склейки — тоже ключ этой франшизы
  if ((kind === "same" || kind === "split") && !db.prepare("SELECT 1 FROM plot_key WHERE root_id = ? AND key = ?").get(root, data.other)) throw new ApiError(400, "Второго персонажа нет в разборе этой франшизы");
  const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const id = Number(db.prepare("INSERT INTO plot_edit (root_id, key, anilist_id, kind, data, from_ep, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(root, key, body.anilistId, kind, JSON.stringify(clean), body.fromEp, user.id, now()).lastInsertRowid);
  if (kind === "image") {
    db.prepare(`INSERT OR REPLACE INTO plot_image (entity_id, url, source, label, look, anilist_id, from_ep, checked, updated_at)
      VALUES (?, ?, 'manual', ?, NULL, ?, ?, 'manual', ?)`).run(body.entityId, clean.url as string, (clean.label as string) || null, body.anilistId, body.fromEp, now());
  }
  await rewrite(root, kind, body.anilistId);
  const e = entityOfKey(root, key);
  const row = e ? db.prepare<[number], { id: number; anilist_char_id: number | null }>("SELECT id, anilist_char_id FROM plot_entity WHERE id = ?").get(e) : null;
  // Привязка к AniList меняет адрес страницы персонажа
  return { id, href: row ? (row.anilist_char_id ? `/characters/${row.anilist_char_id}` : `/characters/e${row.id}`) : null };
}

export async function undoEdit(user: User, id: number): Promise<void> {
  const r = db.prepare<[number], Row>("SELECT * FROM plot_edit WHERE id = ?").get(id);
  if (!r) throw new ApiError(404, "Правка не найдена");
  if (r.undone_at) return;
  db.prepare("UPDATE plot_edit SET undone_at = ? WHERE id = ?").run(now(), id);
  if (r.kind === "image") {
    const e = entityOfKey(r.root_id, r.key);
    if (e) db.prepare("DELETE FROM plot_image WHERE entity_id = ? AND url = ? AND source = 'manual'").run(e, (JSON.parse(r.data) as { url: string }).url);
  }
  await rewrite(r.root_id, r.kind, r.anilist_id);
  console.log(`[plot-edit] ${user.name} отменил правку ${id}`);
}

/** Всё для редактора персонажа — без курсора (правит админ, спойлеры ему видны). */
export async function editorData(entityId: number, anilistId: number): Promise<PlotEditor> {
  const { root, key } = await target(entityId, anilistId);
  const d = await getDetails(anilistId);
  const chars = await titleCharacters(anilistId, d.idMal).catch(() => []);
  const e = db.prepare<[number], { anilist_char_id: number | null; name: string; name_ru: string | null }>("SELECT anilist_char_id, name, name_ru FROM plot_entity WHERE id = ?").get(entityId)!;
  const nameOf = (id: number) => db.prepare<[number], { n: string }>("SELECT COALESCE(name_ru, name) AS n FROM plot_entity WHERE id = ?").get(id)?.n ?? "?";
  const keyName = (k: string) => { const x = entityOfKey(root, k); return x ? nameOf(x) : k; };
  const others = db.prepare<[number, number], { key: string; entity_id: number }>(`
    SELECT k.key, k.entity_id FROM plot_key k JOIN plot_entity e ON e.id = k.entity_id
    WHERE k.root_id = ? AND e.kind = 'character' AND k.entity_id != ? ORDER BY COALESCE(e.name_ru, e.name)`).all(root, entityId)
    .map((r) => ({ key: r.key, entityId: r.entity_id, name: nameOf(r.entity_id) }));
  const identities = db.prepare<[number, number], { a: number; b: number; anilist_id: number; revealed_ep: number; source: string }>(
    "SELECT a, b, anilist_id, revealed_ep, source FROM plot_identity WHERE a = ? OR b = ?").all(entityId, entityId).map((i) => {
    const other = i.a === entityId ? i.b : i.a;
    const otherKey = db.prepare<[number, number], { key: string }>("SELECT key FROM plot_key WHERE root_id = ? AND entity_id = ?").get(root, other)?.key ?? null;
    return { otherKey, name: nameOf(other), anilistId: i.anilist_id, ep: i.revealed_ep };
  });
  const users = new Map(db.prepare<[], { id: number; name: string }>("SELECT id, name FROM users").all().map((u) => [u.id, u.name]));
  const edits = db.prepare<[number, string], Row>("SELECT * FROM plot_edit WHERE root_id = ? AND (key = ?2 OR (kind IN ('same', 'split') AND data LIKE '%' || ?2 || '%')) ORDER BY id DESC").all(root, key)
    .map((r) => {
      const data = JSON.parse(r.data) as Record<string, unknown>;
      return {
        id: r.id, kind: r.kind, anilistId: r.anilist_id, fromEp: r.from_ep, author: users.get(r.user_id) ?? "?", at: r.created_at, undone: r.undone_at !== null,
        text: r.kind === "anilist" ? (Number(data.charId) ? chars.find((c) => c.id === data.charId)?.nameRu ?? chars.find((c) => c.id === data.charId)?.name ?? `#${data.charId}` : "не связан")
          : r.kind === "same" || r.kind === "split" ? `${keyName(r.key)} и ${keyName(String(data.other))}`
          : String(data.name ?? data.description ?? data.url ?? ""),
      };
    });
  return {
    root, key, entityId, anilistId, total: d.episodes ?? (d.nextAiringEpisode ? d.nextAiringEpisode.episode - 1 : null),
    name: e.name_ru ?? e.name, anilistCharId: e.anilist_char_id,
    candidates: chars.map((c) => ({ id: c.id, name: c.nameRu ?? c.name, native: c.native, image: c.image, role: c.role })),
    others, identities,
    names: db.prepare<[number], { name: string; anilist_id: number; from_ep: number; source: string }>("SELECT name, anilist_id, from_ep, source FROM plot_name WHERE entity_id = ? ORDER BY anilist_id, from_ep").all(entityId)
      .map((n) => ({ name: n.name, anilistId: n.anilist_id, fromEp: n.from_ep })),
    notes: db.prepare<[number], { anilist_id: number; up_to: number; description: string }>("SELECT anilist_id, up_to, description FROM plot_note WHERE entity_id = ? ORDER BY anilist_id, up_to").all(entityId)
      .map((n) => ({ anilistId: n.anilist_id, upTo: n.up_to, description: n.description })),
    images: db.prepare<[number], { url: string; source: string; label: string | null; anilist_id: number | null; from_ep: number | null }>("SELECT url, source, label, anilist_id, from_ep FROM plot_image WHERE entity_id = ? ORDER BY from_ep").all(entityId)
      .map((i) => ({ url: i.url, source: i.source, label: i.label, anilistId: i.anilist_id, fromEp: i.from_ep })),
    edits,
  };
}
