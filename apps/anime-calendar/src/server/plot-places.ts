import "server-only";
import type { PlaceDetails, TitlePlaces } from "@/lib/types";
import { db } from "./db";
import { currentImage, hrefOf, nameAt, titleCursor, viewerCursor } from "./plot-graph";
import { ApiError } from "./route";

// Места тайтла (сущности kind = 'place' графа) на курсор зрителя: список и страница места. Место, которого зритель
// ещё не видел, не показывается; его название, детали и события — тоже.

type Ent = { id: number; name: string; name_ru: string | null; kind: string; anilist_char_id: number | null };
const ent = (id: number) => db.prepare<[number], Ent>("SELECT id, name, name_ru, kind, anilist_char_id FROM plot_entity WHERE id = ?").get(id) ?? null;

type Row = { id: number; kind: string; inside_id: number | null; from_ep: number };
const placeRow = (id: number, anilistId: number) =>
  db.prepare<[number, number], Row>("SELECT entity_id AS id, kind, inside_id, from_ep FROM plot_place WHERE entity_id = ? AND anilist_id = ?").get(id, anilistId) ?? null;

/** Описание места на курсор: последняя заметка разбора, которую зритель может видеть. */
const noteAt = (id: number, anilistId: number, k: number) =>
  db.prepare<[number, number, number], { description: string }>(
    "SELECT description FROM plot_note WHERE entity_id = ? AND anilist_id = ? AND up_to <= ? ORDER BY up_to DESC LIMIT 1").get(id, anilistId, k)?.description ?? null;

async function cursorFor(userId: number, anilistId: number) {
  const info = await titleCursor(userId, anilistId);
  const cursor = viewerCursor(userId);
  cursor.set(anilistId, info.ep);
  return { info, cursor, k: info.ep };
}

/** Места тайтла, известные к курсору: по порядку появления, у каждого — родитель и число событий до курсора. */
export async function titlePlaces(userId: number, anilistId: number): Promise<TitlePlaces> {
  const { info, cursor, k } = await cursorFor(userId, anilistId);
  const rows = db.prepare<[number], Row>("SELECT entity_id AS id, kind, inside_id, from_ep FROM plot_place WHERE anilist_id = ? ORDER BY from_ep").all(anilistId);
  const visible = rows.filter((r) => r.from_ep <= k);
  const known = new Set(visible.map((r) => r.id));
  const events = db.prepare<[number, number, number], { n: number }>(
    "SELECT COUNT(*) AS n FROM plot_event WHERE place_id = ? AND anilist_id = ? AND COALESCE(revealed_ep, ep_to, ep_from, 0) <= ?");
  const places = visible.map((r) => {
    const e = ent(r.id)!;
    const parent = r.inside_id !== null && known.has(r.inside_id) ? ent(r.inside_id) : null;
    return {
      id: r.id, name: nameAt(e, cursor), kind: r.kind, inside: parent ? nameAt(parent, cursor) : null, firstEp: r.from_ep,
      description: noteAt(r.id, anilistId, k), events: events.get(r.id, anilistId, k)!.n,
    };
  });
  const map = Boolean(db.prepare<[number], { n: number }>(`
    SELECT 1 AS n FROM plot_place_pos pos JOIN plot_place p ON p.entity_id = pos.entity_id WHERE p.anilist_id = ? LIMIT 1`).get(anilistId));
  return { cursor: info, places, hidden: rows.length - visible.length, map };
}

/** Страница места на курсор. Место после курсора — только серия, когда оно появится. */
export async function placeDetails(userId: number, anilistId: number, placeId: number): Promise<PlaceDetails> {
  const { info, cursor, k } = await cursorFor(userId, anilistId);
  const row = placeRow(placeId, anilistId);
  const e = ent(placeId);
  if (!row || !e || e.kind !== "place") throw new ApiError(404, "Место не найдено");
  const empty: PlaceDetails = {
    cursor: info, hiddenUntil: row.from_ep, id: placeId, name: "", nameEn: "", kind: row.kind, firstEp: row.from_ep, description: null,
    names: [], futureNames: 0, path: [], children: [], links: [], events: [], people: [], onMap: false,
  };
  if (row.from_ep > k) return empty;

  // Вложенность вверх: деревня → лес → страна (только известные зрителю)
  const path: PlaceDetails["path"] = [];
  for (let p = row.inside_id, guard = 0; p !== null && guard < 8; guard++) {
    const r = placeRow(p, anilistId);
    const pe = ent(p);
    if (!r || !pe || r.from_ep > k) break;
    path.unshift({ id: p, name: nameAt(pe, cursor) });
    p = r.inside_id;
  }
  const allNames = db.prepare<[number, number], { name: string; from_ep: number }>("SELECT name, from_ep FROM plot_name WHERE entity_id = ? AND anilist_id = ? ORDER BY from_ep").all(placeId, anilistId);
  const names = allNames.filter((n) => n.from_ep <= k).map((n) => ({ name: n.name, fromEp: n.from_ep }));
  const children = db.prepare<[number, number], Row>("SELECT entity_id AS id, kind, inside_id, from_ep FROM plot_place WHERE inside_id = ? AND anilist_id = ? ORDER BY from_ep").all(placeId, anilistId)
    .filter((c) => c.from_ep <= k).map((c) => ({ id: c.id, name: nameAt(ent(c.id)!, cursor), kind: c.kind, firstEp: c.from_ep }));
  type L = { a: number; b: number; kind: string; distance: string | null; revealed_ep: number };
  const links = db.prepare<[number, number, number], L>("SELECT a, b, kind, distance, revealed_ep FROM plot_place_link WHERE anilist_id = ? AND (a = ? OR b = ?)").all(anilistId, placeId, placeId)
    .filter((l) => l.revealed_ep <= k)
    .map((l) => {
      const other = l.a === placeId ? l.b : l.a;
      // «Дваргон к северу от леса» на странице леса читается как «к северу — Дваргон»
      const kind = l.a === placeId ? l.kind : ({ "к северу от": "к югу от", "к югу от": "к северу от", "к востоку от": "к западу от", "к западу от": "к востоку от" } as Record<string, string>)[l.kind] ?? l.kind;
      return { id: other, name: nameAt(ent(other)!, cursor), kind, distance: l.distance, ep: l.revealed_ep };
    });
  type Ev = { id: number; key: string | null; title: string; summary: string | null; kind: string | null; ep_from: number | null; major: number };
  const evRows = db.prepare<[number, number, number], Ev>(`
    SELECT id, key, title, summary, kind, ep_from, major FROM plot_event WHERE place_id = ? AND anilist_id = ? AND COALESCE(revealed_ep, ep_to, ep_from, 0) <= ? ORDER BY ep_from`)
    .all(placeId, anilistId, k);
  // Кто бывал: участники событий здесь (персонажи), с серии первого визита
  const people = new Map<number, PlaceDetails["people"][number]>();
  const part = db.prepare<[number], { entity_id: number }>("SELECT entity_id FROM plot_event_participant WHERE event_id = ?");
  for (const ev of evRows) for (const { entity_id } of part.all(ev.id)) {
    const p = ent(entity_id);
    if (!p || p.kind !== "character" || people.has(p.id)) continue;
    people.set(p.id, { id: p.id, name: nameAt(p, cursor), href: hrefOf(p), image: currentImage(p.id, cursor)?.url ?? null, firstEp: ev.ep_from ?? 0 });
  }
  return {
    ...empty, hiddenUntil: null, name: nameAt(e, cursor), nameEn: e.name, description: noteAt(placeId, anilistId, k),
    names, futureNames: allNames.length - names.length, path, children, links,
    events: evRows.map((r) => ({ key: r.key, title: r.title, summary: r.summary, kind: r.kind, ep: r.ep_from ?? 0, major: Boolean(r.major) })),
    people: [...people.values()],
    onMap: Boolean(db.prepare<[number], { n: number }>("SELECT 1 AS n FROM plot_place_pos WHERE entity_id = ?").get(placeId)),
  };
}

