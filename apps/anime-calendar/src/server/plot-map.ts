import "server-only";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { JsonSchema } from "@/lib/json-lite";
import { dedupeLabels, dropLegend, FOG_RADIUS, insidePoint, isLegendText, legendEdge, matchLabel, mergeLines, plausibleLabel, tiles, type Box, type MapLabel } from "@/lib/plot-map";
import type { PlotMap } from "@/lib/types";
import { getDetails } from "./anilist";
import { db, now } from "./db";
import { originalFile } from "./img-cache";
import { bestOutput, hashOf, recordOutput } from "./knowledge";
import { LlmUnavailable, runTask } from "./llm";
import { prequelChain } from "./plot";
import { currentImage, hrefOf, nameAt, seen, titleCursor, viewerCursor } from "./plot-graph";
import { fandomHost, wikiJson } from "./plot-looks";
import { registerHandler } from "./tasks";

// Карта мест франшизы (основа — официальная карта с вики тайтла). Карту находим поиском файлов вики, легенду
// (текст рядом с рисунком) отрезаем, подписи читает модель со зрением кусками ~700 px (иначе мелкий текст не виден),
// места графа ставим на подписи (по названию, спорные — моделью), место без подписи — внутрь родителя.
// Подписи и точки хранятся; зритель видит только места, известные к его серии, остальные подписи закрыты.

// ---------------------------------------------------------------- карта и подписи

type WikiFile = { title: string; imageinfo?: { url: string; width: number; height: number }[] };

/** Карта мира на вики: файлы с «map» в названии, самый крупный; пустые («Blank») — нет, на них нечего читать. */
async function wikiMap(host: string): Promise<{ url: string; width: number; height: number } | null> {
  const api = `https://${host}/api.php?format=json&formatversion=2&`;
  const s = await wikiJson<{ query?: { search?: { title: string }[] } }>(`${api}action=query&list=search&srnamespace=6&srlimit=15&srsearch=${encodeURIComponent("world map")}`);
  const titles = (s?.query?.search ?? []).map((x) => x.title).filter((t) => /map/i.test(t) && !/blank/i.test(t)).slice(0, 10);
  if (!titles.length) return null;
  const r = await wikiJson<{ query?: { pages?: WikiFile[] } }>(`${api}action=query&prop=imageinfo&iiprop=url|size&titles=${encodeURIComponent(titles.join("|"))}`);
  const files = (r?.query?.pages ?? []).map((p) => p.imageinfo?.[0]).filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.width >= 1500);
  return files.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

const BOX_SCHEMA: JsonSchema = { type: "object", properties: { bbox_2d: { type: "array", items: { type: "number" } } }, required: ["bbox_2d"] };

/** Рисунок карты без легенды: модель отмечает рамку рисунка на уменьшенной картинке. Не вышло — вся картинка. */
async function mapArea(img: Buffer, width: number, height: number): Promise<Box> {
  const whole = { x: 0, y: 0, w: width, h: height };
  const small = (await sharp(img).resize(1000, 1000, { fit: "inside" }).png().toBuffer()).toString("base64");
  const res = await runTask<{ bbox_2d: number[] }>("look", {
    schema: BOX_SCHEMA, images: [small], maxTokens: 300, timeoutMs: 180_000, freeform: true,
    system: "You locate regions in images.",
    user: 'This image is a fantasy world map, maybe with a text legend beside it. Give the bounding box of the drawn map only, without the legend text. JSON {"bbox_2d": [x1, y1, x2, y2]}.',
  }).catch((e: unknown) => { if (e instanceof LlmUnavailable) throw e; return null; });
  const b = res?.value.bbox_2d;
  if (!b || b.length !== 4) return whole;
  const box = { x: Math.round((b[0] / 1000) * width), y: Math.round((b[1] / 1000) * height), w: Math.round(((b[2] - b[0]) / 1000) * width), h: Math.round(((b[3] - b[1]) / 1000) * height) };
  // Слишком маленькая рамка — модель отметила что-то не то
  return box.w * box.h < width * height * 0.35 ? whole : box;
}

const LABELS_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "object", properties: { text: { type: "string" }, text_content: { type: "string" }, bbox_2d: { type: "array", items: { type: "number" } } }, required: ["bbox_2d"] },
};

/** Подписи куска: текст и рамка в долях куска. Многострочные подписи склеиваются здесь же. */
async function tileLabels(png: Buffer): Promise<MapLabel[]> {
  const res = await runTask<{ text?: string; text_content?: string; bbox_2d: number[] }[]>("look", {
    schema: LABELS_SCHEMA, images: [png.toString("base64")], maxTokens: 4000, timeoutMs: 300_000, freeform: true,
    system: "You read text on maps.",
    user: 'Read every text label printed on this fantasy map. Output a JSON list only: [{"text": "...", "bbox_2d": [x1, y1, x2, y2]}].',
  });
  const lines = res.value
    .map((l) => ({ text: (l.text ?? l.text_content ?? "").trim(), b: l.bbox_2d }))
    .filter((l) => l.text && l.b.length === 4)
    .map((l) => ({ text: l.text, x: l.b[0] / 1000, y: l.b[1] / 1000, w: (l.b[2] - l.b[0]) / 1000, h: (l.b[3] - l.b[1]) / 1000 }));
  return mergeLines(lines);
}

/** Карта франшизы: найти, отрезать легенду, прочитать подписи. Уже прочитанная та же карта — не читается заново. */
async function buildMap(rootId: number, anilistId: number, signal: AbortSignal, onTile?: (done: number, total: number) => void): Promise<boolean> {
  const host = await fandomHost(anilistId);
  const found = host ? await wikiMap(host) : null;
  if (!found) return false;
  const old = db.prepare<[number], { url: string }>("SELECT url FROM plot_map WHERE root_id = ?").get(rootId);
  const hasLabels = db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM plot_map_label WHERE root_id = ?").get(rootId)!.n > 0;
  // Карта уже прочитана — только дочистить легенду (правило могло появиться позже чтения)
  if (old?.url === found.url && hasLabels) { cleanLegend(rootId); return true; }
  const img = await readFile((await originalFile(found.url)).file);
  const meta = await sharp(img).metadata();
  const width = meta.width ?? found.width, height = meta.height ?? found.height;
  const area = await mapArea(img, width, height);
  const crop = sharp(img).extract({ left: area.x, top: area.y, width: area.w, height: area.h });
  const cropped = await crop.png().toBuffer();
  const parts = tiles(area.w, area.h);
  const all: MapLabel[] = [];
  for (const [i, t] of parts.entries()) {
    signal.throwIfAborted();
    const png = await sharp(cropped).extract({ left: t.x, top: t.y, width: t.w, height: t.h }).png().toBuffer();
    for (const l of await tileLabels(png).catch((e: unknown) => { if (e instanceof LlmUnavailable) throw e; return []; })) {
      all.push({ text: l.text, x: (t.x + l.x * t.w) / area.w, y: (t.y + l.y * t.h) / area.h, w: (l.w * t.w) / area.w, h: (l.h * t.h) / area.h });
    }
    onTile?.(i + 1, parts.length);
  }
  // Легенду справа модель отрезает не всегда — граница карты по столбику абзацев легенды
  const raw = dedupeLabels(all);
  const edge = legendEdge(raw);
  const labels = dropLegend(raw, edge);
  if (edge !== null) area.w = Math.round(area.w * edge);
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO plot_map (root_id, url, width, height, crop, built_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (root_id) DO UPDATE SET url = excluded.url, width = excluded.width, height = excluded.height, crop = excluded.crop, built_at = excluded.built_at`)
      .run(rootId, found.url, width, height, JSON.stringify(area), now());
    db.prepare("DELETE FROM plot_map_label WHERE root_id = ?").run(rootId);
    const ins = db.prepare("INSERT INTO plot_map_label (root_id, text, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)");
    for (const l of labels) ins.run(rootId, l.text, l.x, l.y, l.w, l.h);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

/** Убрать из прочитанных подписей легенду и подрезать рамку карты по ней (повторный вызов ничего не меняет). */
function cleanLegend(rootId: number) {
  const labels = db.prepare<[number], MapLabel>("SELECT text, x, y, w, h FROM plot_map_label WHERE root_id = ?").all(rootId);
  if (!labels.some((l) => isLegendText(l.text))) return;
  const edge = legendEdge(labels);
  const kept = dropLegend(labels, edge);
  const map = db.prepare<[number], { crop: string | null; width: number; height: number }>("SELECT crop, width, height FROM plot_map WHERE root_id = ?").get(rootId)!;
  const crop: Box = map.crop ? JSON.parse(map.crop) : { x: 0, y: 0, w: map.width, h: map.height };
  if (edge !== null) crop.w = Math.round(crop.w * edge);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE plot_map SET crop = ? WHERE root_id = ?").run(JSON.stringify(crop), rootId);
    db.prepare("DELETE FROM plot_map_label WHERE root_id = ?").run(rootId);
    const ins = db.prepare("INSERT INTO plot_map_label (root_id, text, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)");
    for (const l of kept) ins.run(rootId, l.text, l.x, l.y, l.w, l.h);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Цвет фона у каждой подписи: среднее по рамке вокруг неё (сама надпись не входит). Пятно, которым закрыта подпись
 * будущего места, тогда сливается с бумагой или сушей, а не выглядит размытой кляксой.
 */
async function labelColors(rootId: number) {
  const todo = db.prepare<[number], MapLabel & { rowid: number }>("SELECT rowid, text, x, y, w, h FROM plot_map_label WHERE root_id = ? AND color IS NULL").all(rootId);
  if (!todo.length) return;
  const map = db.prepare<[number], { url: string; width: number; height: number; crop: string | null }>("SELECT url, width, height, crop FROM plot_map WHERE root_id = ?").get(rootId)!;
  const crop: Box = map.crop ? JSON.parse(map.crop) : { x: 0, y: 0, w: map.width, h: map.height };
  const { data, info } = await sharp(await readFile((await originalFile(map.url)).file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const xi = Math.min(info.width - 1, Math.max(0, Math.round(x))), yi = Math.min(info.height - 1, Math.max(0, Math.round(y)));
    const i = (yi * info.width + xi) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const set = db.prepare("UPDATE plot_map_label SET color = ? WHERE rowid = ?");
  for (const l of todo) {
    const x0 = crop.x + l.x * crop.w, y0 = crop.y + l.y * crop.h, w = l.w * crop.w, h = l.h * crop.h, pad = Math.max(6, h * 0.6);
    const sum = [0, 0, 0];
    let n = 0;
    for (let t = 0; t <= 1; t += 0.05) for (const [x, y] of [[x0 - pad + t * (w + 2 * pad), y0 - pad], [x0 - pad + t * (w + 2 * pad), y0 + h + pad], [x0 - pad, y0 - pad + t * (h + 2 * pad)], [x0 + w + pad, y0 - pad + t * (h + 2 * pad)]]) {
      const c = at(x, y);
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; n++;
    }
    set.run(`#${sum.map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`, l.rowid);
  }
}

// ---------------------------------------------------------------- места на карте

type PlaceRow = { id: number; name: string; name_ru: string | null; kind: string; inside_id: number | null };

const MATCH_V = 1;
const NONE = "нет подписи";

/**
 * Точки мест франшизы. Подпись — по английскому названию (matchLabel), спорные — одним вызовом модели
 * («Пещера печати» / Sealed Cave → «Cave of Imprisonment»); без подписи — рядом с родителем. Ручные точки не трогаем.
 */
async function placePositions(rootId: number): Promise<number> {
  const places = db.prepare<[number], PlaceRow>(`
    SELECT e.id, e.name, e.name_ru, p.kind, p.inside_id FROM plot_key k JOIN plot_entity e ON e.id = k.entity_id
    JOIN plot_place p ON p.entity_id = e.id WHERE k.root_id = ? AND k.key LIKE 'place-%' GROUP BY e.id`).all(rootId);
  const labels = db.prepare<[number], MapLabel>("SELECT text, x, y, w, h FROM plot_map_label WHERE root_id = ?").all(rootId);
  if (!places.length || !labels.length) return 0;
  // Одна подпись — одному месту (Филтвуда на карте нет — он не должен сесть на подпись Фальмуса)
  const hit = new Map<number, MapLabel>();
  const taken = new Set<string>();
  for (const p of places) {
    const l = matchLabel(p.name, labels.filter((x) => !taken.has(x.text)));
    if (l) { hit.set(p.id, l); taken.add(l.text); }
  }
  const open = places.filter((p) => !hit.has(p.id) && ["страна", "область", "лес", "горы", "пещера", "водоём", "город", "континент"].includes(p.kind));
  if (open.length) {
    const texts = [...new Set(labels.map((l) => l.text))].filter((t) => !taken.has(t));
    const schema: JsonSchema = {
      type: "object", required: ["map"],
      properties: { map: { type: "array", items: { type: "object", required: ["id", "label"], properties: { id: { type: "integer" }, label: { type: "string", enum: [...texts, NONE] } } } } },
    };
    const user = `Места из сериала:\n${open.map((p) => `${p.id} | ${p.name_ru ?? ""} / ${p.name} | ${p.kind}`).join("\n")}\n\nПодписи на карте:\n${texts.join("\n")}`;
    const inputHash = hashOf([MATCH_V, user]);
    const subject = `map-match:${rootId}`;
    type Answer = { map: { id: number; label: string }[] };
    let value = bestOutput<Answer>("plot_graph", subject, { inputHash, policy: "tier-first", staleOk: false })?.value;
    if (!value) {
      const res = await runTask<Answer>("plot_graph", {
        schema, user, maxTokens: 2000, timeoutMs: 180_000,
        system: `Сопоставь места из сериала с подписями на официальной карте мира. Подпись может называть место иначе (перевод, полное название страны). Нет подходящей — «${NONE}». Не угадывай.`,
      });
      value = res.value;
      recordOutput("plot_graph", subject, res, value, { schemaV: 1, promptV: MATCH_V, inputHash });
    }
    for (const m of value.map) {
      const l = labels.find((x) => x.text === m.label);
      const p = open.find((x) => x.id === m.id);
      // Проверка ответа: подпись свободна и похожа на название (одна буква начала значимого слова)
      if (l && p && !taken.has(l.text) && !hit.has(m.id) && plausibleLabel(p.name, l.text)) { hit.set(m.id, l); taken.add(l.text); }
    }
  }
  // Точки: по подписи; без подписи — рядом с родителем (родителя ставим раньше детей)
  const pos = new Map<number, { x: number; y: number; how: string; label: string | null }>();
  for (const [id, l] of hit) pos.set(id, { x: l.x + l.w / 2, y: l.y + l.h / 2, how: "label", label: l.text });
  const children = new Map<number, number>();
  for (let round = 0; round < 5; round++) {
    for (const p of places) {
      if (pos.has(p.id) || p.inside_id === null) continue;
      const parent = pos.get(p.inside_id);
      if (!parent) continue;
      const i = children.get(p.inside_id) ?? 0;
      children.set(p.inside_id, i + 1);
      pos.set(p.id, { ...insidePoint(parent, i), how: "inside", label: null });
    }
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM plot_place_pos WHERE root_id = ? AND how != 'manual'").run(rootId);
    const ins = db.prepare("INSERT OR IGNORE INTO plot_place_pos (entity_id, root_id, x, y, how, label) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [id, p] of pos) ins.run(id, rootId, p.x, p.y, p.how, p.label);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return pos.size;
}

/** Корень франшизы тайтла — по ключам мест графа (граф франшизы общий). */
const rootOf = (anilistId: number) => db.prepare<[number], { root_id: number }>(`
  SELECT k.root_id FROM plot_key k JOIN plot_appearance a ON a.entity_id = k.entity_id WHERE a.anilist_id = ? AND k.key LIKE 'place-%' LIMIT 1`).get(anilistId)?.root_id ?? null;

/** Карта и точки — шаг после сборки графа (карту читаем один раз, точки — каждый раз). */
export async function mapStep(anilistId: number, signal: AbortSignal, onTile?: (done: number, total: number) => void): Promise<{ map: boolean; places: number }> {
  const root = rootOf(anilistId);
  if (root === null) return { map: false, places: 0 };
  const map = await buildMap(root, anilistId, signal, onTile);
  if (map) await labelColors(root);
  return { map, places: map ? await placePositions(root) : 0 };
}

registerHandler("map", {
  noun: "Карта мест готова",
  anilistId: async (key) => Number(key) || null,
  title: async (key) => { const d = await getDetails(Number(key)); return d.title.romaji ?? d.title.english ?? `#${key}`; },
  fresh: () => false,
  href: (key) => `/anime/${key}/map`,
  run: async (key, signal) => {
    const r = await mapStep(Number(key), signal);
    return { summary: r.map ? `Мест на карте: ${r.places}` : "Карты на вики не нашлось", isNew: r.places > 0 };
  },
});

// ---------------------------------------------------------------- для страницы

/** Карта на курсор зрителя: только места, события и пути до его серии; подписи будущих мест закрыты. */
export async function mapView(userId: number, anilistId: number): Promise<PlotMap> {
  const cursorInfo = await titleCursor(userId, anilistId);
  const cursor = viewerCursor(userId);
  cursor.set(anilistId, cursorInfo.ep);
  const root = rootOf(anilistId);
  const map = root === null ? null : db.prepare<[number], { url: string; width: number; height: number; crop: string | null }>("SELECT url, width, height, crop FROM plot_map WHERE root_id = ?").get(root) ?? null;
  if (root === null || !map) return { cursor: cursorInfo, map: null, masks: [], places: [], events: [], people: [], hidden: 0 };
  const d = await getDetails(anilistId);
  const order = [...(await prequelChain(d)), d].map((t) => t.id);
  const rank = (a: number, ep: number) => Math.max(0, order.indexOf(a)) * 10000 + ep;

  type P = { id: number; name: string; name_ru: string | null; kind: string; x: number; y: number; how: string; label: string | null; anilist_id: number; first_ep: number; inside_id: number | null };
  const rows = db.prepare<[number], P>(`
    SELECT e.id, e.name, e.name_ru, pl.kind, pos.x, pos.y, pos.how, pos.label, a.anilist_id, a.first_ep, pl.inside_id
    FROM plot_place_pos pos JOIN plot_entity e ON e.id = pos.entity_id
    JOIN plot_appearance a ON a.entity_id = e.id AND a.first_ep IS NOT NULL
    JOIN plot_place pl ON pl.entity_id = e.id AND pl.anilist_id = a.anilist_id
    WHERE pos.root_id = ? ORDER BY a.first_ep`).all(root);
  const byId = new Map<number, P>();
  for (const r of rows) if (!byId.has(r.id) || rank(r.anilist_id, r.first_ep) < rank(byId.get(r.id)!.anilist_id, byId.get(r.id)!.first_ep)) byId.set(r.id, r);
  const all = [...byId.values()];
  const visible = all.filter((p) => seen(cursor, p.anilist_id, p.first_ep));
  const known = new Set(visible.map((p) => p.label).filter(Boolean));
  // Закрываем все подписи, кроме мест, известных зрителю (на официальной карте есть и страны будущих сезонов)
  const allLabels = db.prepare<[number], MapLabel & { color: string | null }>("SELECT text, x, y, w, h, color FROM plot_map_label WHERE root_id = ?").all(root);
  const masks = allLabels.filter((l) => !known.has(l.text)).map(({ x, y, w, h, color }) => ({ x, y, w, h, color }));
  const labelW = new Map(allLabels.map((l) => [l.text, l.w]));
  // Туман открывается по размеру места: у страны с подписью — по ширине подписи (крупная страна — крупная надпись),
  // у места без подписи — небольшой круг по виду
  const fogR = (p: P) => p.how === "label" && p.label ? Math.max((FOG_RADIUS[p.kind] ?? 0.05) * 0.5, (labelW.get(p.label) ?? 0) * 0.8) : Math.min(FOG_RADIUS[p.kind] ?? 0.04, 0.045);
  const places = visible.map((p) => ({
    id: p.id, name: nameAt(p, cursor), kind: p.kind, x: p.x, y: p.y, approx: p.how === "inside", fog: fogR(p),
    firstEp: p.first_ep, anilistId: p.anilist_id, inside: p.inside_id !== null && byId.has(p.inside_id) && visible.some((v) => v.id === p.inside_id) ? nameAt(byId.get(p.inside_id)!, cursor) : null,
  }));
  const placeIds = new Set(places.map((p) => p.id));

  type Ev = { id: number; key: string | null; anilist_id: number; title: string; kind: string | null; ep_from: number | null; ep_to: number | null; revealed_ep: number | null; major: number; place_id: number };
  const events = db.prepare<[], Ev>(`SELECT id, key, anilist_id, title, kind, ep_from, ep_to, revealed_ep, major, place_id FROM plot_event
    WHERE place_id IS NOT NULL AND source = 'graph' AND anilist_id IN (${order.join(",")})`).all()
    .filter((e) => placeIds.has(e.place_id) && seen(cursor, e.anilist_id, e.revealed_ep ?? e.ep_to ?? e.ep_from))
    .sort((a, b) => rank(a.anilist_id, a.ep_from ?? 0) - rank(b.anilist_id, b.ep_from ?? 0));

  // Пути персонажей: места событий, где они участвовали, по порядку серий (повтор того же места подряд — одна остановка)
  const people = new Map<number, PlotMap["people"][number]>();
  const part = db.prepare<[number], { entity_id: number }>("SELECT entity_id FROM plot_event_participant WHERE event_id = ?");
  const ent = db.prepare<[number], { id: number; name: string; name_ru: string | null; kind: string; anilist_char_id: number | null }>("SELECT id, name, name_ru, kind, anilist_char_id FROM plot_entity WHERE id = ?");
  for (const e of events) {
    for (const { entity_id } of part.all(e.id)) {
      const p = ent.get(entity_id);
      if (!p || p.kind !== "character") continue;
      const person = people.get(p.id) ?? { id: p.id, name: nameAt(p, cursor), href: hrefOf(p), image: currentImage(p.id, cursor)?.url ?? null, stops: [] };
      const last = person.stops.at(-1);
      if (last?.placeId !== e.place_id) person.stops.push({ placeId: e.place_id, anilistId: e.anilist_id, ep: e.ep_from ?? 0 });
      people.set(p.id, person);
    }
  }
  return {
    cursor: cursorInfo,
    map: { url: map.url, width: map.width, height: map.height, crop: map.crop ? JSON.parse(map.crop) : { x: 0, y: 0, w: map.width, h: map.height } },
    masks, places,
    events: events.map((e) => ({ key: e.key, title: e.title, kind: e.kind, anilistId: e.anilist_id, ep: e.ep_from ?? 0, placeId: e.place_id, major: Boolean(e.major) })),
    people: [...people.values()].filter((p) => p.stops.length >= 2).sort((a, b) => b.stops.length - a.stops.length),
    hidden: all.length - visible.length,
  };
}
