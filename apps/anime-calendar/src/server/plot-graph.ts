import "server-only";
import { ruNameOf } from "@/lib/characters";
import { aliasLook, identityGroups, isProperName } from "@/lib/plot-graph";
import type {
  CastMember, CharacterDetails, CharacterLite, CharacterRole, EventBrief, EventDetails, EventLinkInfo, MediaLite, NameRef, PlotCursor, PlotEventInfo,
  NameCard, NameRefs, PlotRelationInfo, PlotViewMode, RelationMap, TitleCast, TitleEvents,
} from "@/lib/types";
import { getDetails, gql, MEDIA_FIELDS, toLite, type RawMedia } from "./anilist";
import { cached } from "./cache";
import { characterGlossary } from "./characters";
import { db, now } from "./db";
import { ApiError } from "./route";
import { withShikimori } from "./lists";

// Граф сюжета — персонажи (идея #79). Состав тайтла и персонажи AniList с русскими именами Shikimori; разбор серий
// (plot-graph-build) дописывает сущности без AniList, имена, облики, группы, отношения и события — у каждой записи
// серия раскрытия. Здесь — чтение с курсором зрителя: что раскрыто позже его серии, не отдаётся.

// ---------------------------------------------------------------- AniList

const TITLE_CHARS = `
query ($id: Int, $page: Int) {
  Media(id: $id, type: ANIME) {
    characters(sort: [ROLE, RELEVANCE, ID], perPage: 50, page: $page) {
      pageInfo { hasNextPage }
      edges {
        role
        node { id name { full native } image { large } }
        voiceActors(language: JAPANESE, sort: [RELEVANCE]) { name { full } }
      }
    }
  }
}`;

type CharEdge = { role: CharacterRole; node: { id: number; name: { full: string; native: string | null }; image: { large: string | null } | null }; voiceActors: { name: { full: string } }[] };

/** Персонажи тайтла (до 100): главные первыми. Неделю из кэша — состав меняется редко. */
export function titleCharacters(animeId: number, malId: number | null): Promise<CharacterLite[]> {
  return cached(`title-chars:v1:${animeId}`, 7 * 86400, async () => {
    const edges: CharEdge[] = [];
    for (let page = 1; page <= 2; page++) {
      const { Media } = await gql<{ Media: { characters: { pageInfo: { hasNextPage: boolean }; edges: CharEdge[] } } }>(TITLE_CHARS, { id: animeId, page });
      edges.push(...Media.characters.edges);
      if (!Media.characters.pageInfo.hasNextPage) break;
    }
    const glossary = await characterGlossary(malId).catch(() => []);
    return edges.map((e) => ({
      id: e.node.id, name: e.node.name.full, native: e.node.name.native, image: e.node.image?.large ?? null, role: e.role,
      nameRu: ruNameOf(glossary, e.node.name.full, e.node.name.native), voice: e.voiceActors[0]?.name.full ?? null,
    }));
  });
}

const CHARACTER = `
query ($id: Int) {
  Character(id: $id) {
    id name { full native alternative } image { large } description(asHtml: false) gender age
    media(sort: [START_DATE], type: ANIME, perPage: 50) { edges { characterRole node { ${MEDIA_FIELDS} } } }
  }
}`;

type RawCharacter = {
  id: number; name: { full: string; native: string | null; alternative: string[] | null }; image: { large: string | null } | null;
  description: string | null; gender: string | null; age: string | null;
  media: { edges: { characterRole: CharacterRole; node: RawMedia }[] };
};

type CharacterBase = Pick<CharacterDetails, "name" | "nameRu" | "native" | "alternative" | "image" | "description" | "gender" | "age" | "appearances"> & { id: number };

function characterBase(id: number): Promise<CharacterBase> {
  return cached(`character:v1:${id}`, 7 * 86400, async () => {
    const { Character: c } = await gql<{ Character: RawCharacter }>(CHARACTER, { id });
    const appearances = c.media.edges.map((e) => ({ media: toLite(e.node), role: e.characterRole }));
    // Русское имя — по словарю первого тайтла, где он главный (иначе — первого с MAL id)
    const first = appearances.find((a) => a.role === "MAIN" && a.media.idMal) ?? appearances.find((a) => a.media.idMal);
    const glossary = first ? await characterGlossary(first.media.idMal).catch(() => []) : [];
    return {
      id: c.id, name: c.name.full, native: c.name.native, alternative: (c.name.alternative ?? []).filter(Boolean),
      image: c.image?.large ?? null, description: c.description, gender: c.gender, age: c.age,
      nameRu: ruNameOf(glossary, c.name.full, c.name.native), appearances,
    };
  });
}

// ---------------------------------------------------------------- сущности графа

/** Персонажи тайтла → сущности графа, их появления и портрет AniList (источник — AniList). Имена и портрет обновляются. */
export function seedCharacters(animeId: number, chars: CharacterLite[]) {
  const up = db.prepare(`INSERT INTO plot_entity (kind, anilist_char_id, name, name_ru, name_ja, image, created_at, updated_at)
    VALUES ('character', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (anilist_char_id) DO UPDATE SET name = excluded.name, name_ru = COALESCE(excluded.name_ru, plot_entity.name_ru),
      name_ja = excluded.name_ja, image = excluded.image, updated_at = excluded.updated_at`);
  const app = db.prepare(`INSERT INTO plot_appearance (entity_id, anilist_id, role, source)
    SELECT id, ?, ?, 'anilist' FROM plot_entity WHERE anilist_char_id = ?
    ON CONFLICT (entity_id, anilist_id) DO UPDATE SET role = excluded.role`);
  // Портрет — кандидат в облики: какой облик на нём и с какой серии показывать, решит проверка (plot-looks)
  const img = db.prepare(`INSERT INTO plot_image (entity_id, url, source, updated_at)
    SELECT id, ?, 'anilist', ? FROM plot_entity WHERE anilist_char_id = ? ON CONFLICT (entity_id, url) DO NOTHING`);
  const t = now();
  for (const c of chars) {
    up.run(c.id, c.name, c.nameRu, c.native, c.image, t, t);
    app.run(animeId, c.role, c.id);
    if (c.image) img.run(c.image, t, c.id);
  }
}

type Entity = { id: number; kind: string; anilist_char_id: number | null; name: string; name_ru: string | null; name_ja: string | null; image: string | null };
const entity = (id: number) => db.prepare<[number], Entity>("SELECT id, kind, anilist_char_id, name, name_ru, name_ja, image FROM plot_entity WHERE id = ?").get(id) ?? null;
export const hrefOf = (e: Pick<Entity, "id" | "anilist_char_id">) => e.anilist_char_id ? `/characters/${e.anilist_char_id}` : `/characters/e${e.id}`;
const nameOf = (e: Pick<Entity, "name" | "name_ru">) => e.name_ru ?? e.name;

// ---------------------------------------------------------------- курсор зрителя

const ALL = 1e6;

/** Досмотрено по тайтлам: список (просмотрено целиком — весь тайтл) с поправкой «сюжет на серию N». */
export function viewerCursor(userId: number): Map<number, number> {
  const out = new Map(db.prepare<[number], { anilist_id: number; status: string; episodes: number }>(
    "SELECT anilist_id, status, episodes FROM list_entries WHERE user_id = ? AND deleted = 0").all(userId)
    .map((r) => [r.anilist_id, r.status === "completed" ? ALL : r.episodes]));
  for (const v of db.prepare<[number], { anilist_id: number; mode: PlotViewMode; ep: number | null }>("SELECT anilist_id, mode, ep FROM plot_view WHERE user_id = ?").all(userId)) {
    if (v.mode === "all") out.set(v.anilist_id, ALL);
    else if (v.mode === "ep" && v.ep !== null) out.set(v.anilist_id, v.ep);
  }
  return out;
}

/** Курсор тайтла для страницы: режим, мой прогресс и итог. */
export async function titleCursor(userId: number, anilistId: number): Promise<PlotCursor> {
  const d = await getDetails(anilistId);
  const total = d.episodes ?? (d.nextAiringEpisode ? d.nextAiringEpisode.episode - 1 : null);
  const entry = db.prepare<[number, number], { status: string; episodes: number }>(
    "SELECT status, episodes FROM list_entries WHERE user_id = ? AND anilist_id = ? AND deleted = 0").get(userId, anilistId);
  const watched = !entry ? 0 : entry.status === "completed" ? (total ?? ALL) : entry.episodes;
  const view = db.prepare<[number, number], { mode: PlotViewMode; ep: number | null }>("SELECT mode, ep FROM plot_view WHERE user_id = ? AND anilist_id = ?").get(userId, anilistId);
  const mode = view?.mode ?? "progress";
  const ep = mode === "all" ? ALL : mode === "ep" ? (view?.ep ?? watched) : watched;
  return { ep, mode, watched, inList: Boolean(entry), total };
}

export function setPlotView(userId: number, anilistId: number, mode: PlotViewMode, ep: number | null) {
  if (mode === "progress") db.prepare("DELETE FROM plot_view WHERE user_id = ? AND anilist_id = ?").run(userId, anilistId);
  else db.prepare(`INSERT INTO plot_view (user_id, anilist_id, mode, ep) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, anilist_id) DO UPDATE SET mode = excluded.mode, ep = excluded.ep`).run(userId, anilistId, mode, mode === "ep" ? ep : null);
}

const seen = (cursor: Map<number, number>, anilistId: number | null, ep: number | null) => (ep ?? 0) <= (anilistId === null ? ALL : cursor.get(anilistId) ?? 0);

// ---------------------------------------------------------------- облики и «это один человек»

type ImageRow = { entity_id: number; url: string; label: string | null; anilist_id: number | null; from_ep: number | null; source: string };

/**
 * Картинки персонажа, которые зритель может видеть. Портрет без проверки облика показываем осторожно:
 * с последнего облика первого тайтла (у персонажа без смены обликов это его первое появление).
 */
function imagesOf(entityId: number, cursor: Map<number, number>): { visible: ImageRow[]; future: number } {
  const rows = db.prepare<[number], ImageRow>("SELECT entity_id, url, label, anilist_id, from_ep, source FROM plot_image WHERE entity_id = ?").all(entityId);
  const fallback = db.prepare<[number], { anilist_id: number; ep: number }>(`
    SELECT a.anilist_id, COALESCE((SELECT MAX(from_ep) FROM plot_look l WHERE l.entity_id = a.entity_id AND l.anilist_id = a.anilist_id AND l.kind != 'прошлое'), a.first_ep) AS ep
    FROM plot_appearance a WHERE a.entity_id = ? AND a.first_ep IS NOT NULL ORDER BY a.first_ep LIMIT 1`).get(entityId);
  const out: ImageRow[] = [];
  let future = 0;
  for (const r of rows) {
    // Картинка с вики, в которой модель не узнала ни одного облика из сериала, — не показываем: вероятно, облик из будущего
    if (r.source === "fandom" && r.from_ep === null) { future++; continue; }
    const at = r.from_ep !== null ? r : fallback ? { ...r, anilist_id: fallback.anilist_id, from_ep: fallback.ep } : r;
    if (seen(cursor, at.anilist_id, at.from_ep)) out.push(at);
    else future++;
  }
  return { visible: out.sort((a, b) => (a.from_ep ?? 0) - (b.from_ep ?? 0)), future };
}

const currentImage = (entityId: number, cursor: Map<number, number>) => imagesOf(entityId, cursor).visible.at(-1) ?? null;

/** Склеенные с сущностью «это один человек», раскрытые к курсору (вместе с ней самой). */
function identityOf(entityId: number, cursor: Map<number, number>): number[] {
  const rows = db.prepare<[], { a: number; b: number; anilist_id: number; revealed_ep: number }>("SELECT a, b, anilist_id, revealed_ep FROM plot_identity").all()
    .filter((r) => seen(cursor, r.anilist_id, r.revealed_ep)).map((r) => ({ a: r.a, b: r.b, revealed: 0 }));
  return identityGroups(rows, 0).get(entityId) ?? [entityId];
}

/** Главная сущность группы склеенных: персонаж AniList, иначе самая ранняя. */
function canonical(ids: number[]): number {
  const es = ids.map(entity).filter((e): e is Entity => e !== null);
  return (es.find((e) => e.anilist_char_id) ?? es.sort((a, b) => a.id - b.id)[0])?.id ?? ids[0];
}

// ---------------------------------------------------------------- отношения, события, группы

function relationsOf(ids: number[], cursor: Map<number, number>): PlotRelationInfo[] {
  type Row = { other: number; kind: string; label: string | null; anilist_id: number; from_ep: number | null; ended_ep: number | null; revealed_ep: number | null };
  const set = new Set(ids);
  const out: PlotRelationInfo[] = [];
  for (const id of ids) {
    const rows = db.prepare<[number], Row>(`
      SELECT CASE WHEN r.a = ?1 THEN r.b ELSE r.a END AS other, r.kind, r.label, r.anilist_id, r.from_ep, r.ended_ep, r.revealed_ep
      FROM plot_relation r WHERE r.a = ?1 OR r.b = ?1 ORDER BY r.anilist_id, r.from_ep`).all(id);
    for (const r of rows) {
      if (set.has(r.other) || !seen(cursor, r.anilist_id, r.revealed_ep ?? r.from_ep)) continue;
      // Другой участник мог быть склеен с кем-то — ссылка ведёт на главную сущность, имя — как зритель знает его сейчас
      const other = entity(canonical(identityOf(r.other, cursor)));
      if (!other) continue;
      out.push({
        otherId: other.id, otherHref: hrefOf(other), otherName: nameOf(other), otherImage: currentImage(other.id, cursor)?.url ?? null,
        kind: r.kind, label: r.label, anilistId: r.anilist_id, fromEp: r.from_ep,
        endedEp: r.ended_ep !== null && seen(cursor, r.anilist_id, r.ended_ep) ? r.ended_ep : null,
      });
    }
  }
  return out;
}

function eventsOf(ids: number[], cursor: Map<number, number>): PlotEventInfo[] {
  type Row = { id: number; key: string | null; anilist_id: number; title: string; summary: string | null; kind: string | null; ep_from: number | null; ep_to: number | null; revealed_ep: number | null; major: number; role: string | null };
  const rows = db.prepare<[], Row>(`
    SELECT DISTINCT ev.id, ev.key, ev.anilist_id, ev.title, ev.summary, ev.kind, ev.ep_from, ev.ep_to, ev.revealed_ep, ev.major, p.role
    FROM plot_event ev JOIN plot_event_participant p ON p.event_id = ev.id
    WHERE p.entity_id IN (${ids.join(",")}) AND ev.level != 'moment'`).all();
  return rows.filter((r) => seen(cursor, r.anilist_id, r.revealed_ep ?? r.ep_to ?? r.ep_from))
    .sort((a, b) => a.anilist_id - b.anilist_id || (a.ep_from ?? 0) - (b.ep_from ?? 0))
    .map((r) => ({ id: r.id, key: r.key, anilistId: r.anilist_id, title: r.title, summary: r.summary, kind: r.kind, epFrom: r.ep_from, epTo: r.ep_to, major: Boolean(r.major), role: r.role }));
}

function groupsOf(ids: number[], cursor: Map<number, number>) {
  type Row = { group_id: number; role: string | null; anilist_id: number; from_ep: number; to_ep: number | null };
  return db.prepare<[], Row>(`SELECT group_id, role, anilist_id, from_ep, to_ep FROM plot_member WHERE entity_id IN (${ids.join(",")}) ORDER BY from_ep`).all()
    .filter((m) => seen(cursor, m.anilist_id, m.from_ep))
    .map((m) => ({ id: m.group_id, name: nameOf(entity(m.group_id) ?? { name: "?", name_ru: null }), role: m.role, past: m.to_ep !== null && seen(cursor, m.anilist_id, m.to_ep) }));
}

/** Описание по разбору серий на курсор: последняя заметка, которую зритель может видеть. */
function noteOf(ids: number[], cursor: Map<number, number>) {
  return db.prepare<[], { description: string; goal: string | null; anilist_id: number; up_to: number }>(
    `SELECT description, goal, anilist_id, up_to FROM plot_note WHERE entity_id IN (${ids.join(",")}) ORDER BY up_to`).all()
    .filter((n) => seen(cursor, n.anilist_id, n.up_to)).at(-1) ?? null;
}

// ---------------------------------------------------------------- страница персонажа

/** Сущность по параметру адреса: «e123» — сущность графа, число — персонаж AniList. */
export function entityByParam(param: string): { entityId: number | null; anilistCharId: number | null } {
  const m = /^e(\d+)$/.exec(param);
  if (m) {
    const e = entity(Number(m[1]));
    return { entityId: e?.id ?? null, anilistCharId: e?.anilist_char_id ?? null };
  }
  const n = Number(param);
  if (!Number.isInteger(n) || n <= 0) return { entityId: null, anilistCharId: null };
  return { entityId: db.prepare<[number], { id: number }>("SELECT id FROM plot_entity WHERE anilist_char_id = ?").get(n)?.id ?? null, anilistCharId: n };
}

/** Страница персонажа: AniList (если есть), облики, имена, склейки, отношения, события и способности — до курсора зрителя. */
export async function characterDetails(param: string, cursor: Map<number, number>): Promise<CharacterDetails> {
  const { entityId, anilistCharId } = entityByParam(param);
  if (entityId === null && anilistCharId === null) throw new Error("Персонаж не найден");
  const base = anilistCharId !== null ? structuredClone(await characterBase(anilistCharId)) : null;
  const e = entityId !== null ? entity(entityId) : null;
  const ids = entityId !== null ? identityOf(entityId, cursor) : [];
  const main = ids.length ? canonical(ids) : null;
  const redirect = main !== null && main !== entityId ? hrefOf(entity(main)!) : null;

  // Появления: AniList + тайтлы, где персонаж есть только по разбору серий
  const appearances = base?.appearances ?? [];
  const graphApps = ids.length ? db.prepare<[], { anilist_id: number; role: CharacterRole | null; first_ep: number | null }>(
    `SELECT anilist_id, role, MIN(first_ep) AS first_ep FROM plot_appearance WHERE entity_id IN (${ids.join(",")}) GROUP BY anilist_id`).all() : [];
  for (const a of graphApps) {
    if (appearances.some((x) => x.media.id === a.anilist_id)) continue;
    const d = await getDetails(a.anilist_id).catch(() => null);
    if (d) appearances.push({ media: d as MediaLite, role: a.role ?? "SUPPORTING" });
  }
  await withShikimori(appearances.map((a) => a.media));
  // Ещё не появлялся у зрителя ни в одном тайтле, где он известен по разбору
  const firsts = graphApps.filter((a) => a.first_ep !== null);
  const hiddenUntil = firsts.length && firsts.every((a) => !seen(cursor, a.anilist_id, a.first_ep))
    ? (() => { const f = firsts.sort((a, b) => (a.first_ep ?? 0) - (b.first_ep ?? 0))[0]; return { anilistId: f.anilist_id, ep: f.first_ep! }; })() : null;

  // Имена: из разбора серий — с серии, где их узнали; чужие склеенные — только после раскрытия
  type AliasRow = { alias: string; kind: string | null; who: string | null; anilist_id: number | null; from_ep: number | null; revealed_ep: number | null };
  const aliasRows = ids.length ? db.prepare<[], AliasRow>(`SELECT alias, kind, who, anilist_id, from_ep, revealed_ep FROM plot_alias WHERE entity_id IN (${ids.join(",")}) ORDER BY revealed_ep`).all() : [];
  const names = aliasRows.filter((a) => seen(cursor, a.anilist_id, a.revealed_ep))
    .map((a) => ({ name: a.alias, kind: a.kind ?? "имя", who: a.who, fromEp: a.from_ep, anilistId: a.anilist_id }));
  const aka = ids.filter((x) => x !== main).map((x) => {
    const o = entity(x)!;
    const r = db.prepare<[number, number, number, number], { anilist_id: number; revealed_ep: number }>(
      "SELECT anilist_id, revealed_ep FROM plot_identity WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").get(x, main!, main!, x);
    return { name: nameOf(o), href: hrefOf(o), revealedEp: r?.revealed_ep ?? 0, anilistId: r?.anilist_id ?? 0 };
  });

  const imgs = ids.length ? ids.map((x) => imagesOf(x, cursor)) : [];
  const looks = imgs.flatMap((x) => x.visible).sort((a, b) => (a.from_ep ?? 0) - (b.from_ep ?? 0))
    .map((r) => ({ image: r.url, label: r.label, anilistId: r.anilist_id, fromEp: r.from_ep }));
  const note = ids.length ? noteOf(ids, cursor) : null;
  const powers = ids.length ? db.prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM plot_title WHERE power_system = 1 AND anilist_id IN (SELECT anilist_id FROM plot_appearance WHERE entity_id IN (${ids.join(",")}))`).get()!.n > 0 : false;
  const abilities = powers ? (() => {
    type Ab = { name: string; text: string | null; status: string; from_ep: number; anilist_id: number };
    const rows = db.prepare<[], Ab>(`SELECT name, text, status, from_ep, anilist_id FROM plot_ability WHERE entity_id IN (${ids.join(",")}) ORDER BY anilist_id, from_ep`).all()
      .filter((a) => seen(cursor, a.anilist_id, a.from_ep));
    // У способности — последний статус, который зритель видел
    const last = new Map<string, Ab>();
    for (const a of rows) last.set(a.name.toLowerCase(), { ...a, from_ep: last.get(a.name.toLowerCase())?.from_ep ?? a.from_ep });
    return [...last.values()].map((a) => ({ name: a.name, text: a.text, status: a.status, fromEp: a.from_ep, anilistId: a.anilist_id }));
  })() : null;

  const name = base?.nameRu ?? (e ? nameOf(e) : base?.name ?? "");
  return {
    id: anilistCharId, entityId, href: e ? hrefOf(e) : `/characters/${anilistCharId}`,
    name: base?.name ?? e?.name ?? "", nameRu: base?.nameRu ?? e?.name_ru ?? null, native: base?.native ?? e?.name_ja ?? null,
    alternative: base?.alternative ?? [],
    // Портрет AniList — только если он уже среди показанных обликов
    image: looks.at(-1)?.image ?? (ids.length ? null : base?.image ?? null),
    description: base?.description ?? null, plotDescription: note?.description ?? null, goal: note?.goal ?? null,
    gender: base?.gender ?? null, age: base?.age ?? null,
    looks, futureLooks: imgs.reduce((a, x) => a + x.future, 0),
    names: names.length ? names : [{ name, kind: "имя", who: null, fromEp: null, anilistId: null }],
    futureNames: aliasRows.length - names.length,
    aka, redirect, hiddenUntil,
    groups: ids.length ? groupsOf(ids, cursor) : [],
    appearances, relations: ids.length ? relationsOf(ids, cursor) : [], events: ids.length ? eventsOf(ids, cursor) : [], abilities,
  };
}

// ---------------------------------------------------------------- состав тайтла

/** Персонажи тайтла на курсор: из разбора серий (кто уже появился), без разбора — состав AniList. */
export async function titleCast(userId: number, anilistId: number, at?: number): Promise<TitleCast> {
  const cursorInfo = await titleCursor(userId, anilistId);
  const k = at ?? cursorInfo.ep;
  const cursor = viewerCursor(userId);
  cursor.set(anilistId, k);
  const d = await getDetails(anilistId);
  const chars = await titleCharacters(anilistId, d.idMal);
  seedCharacters(anilistId, chars);
  const title = db.prepare<[number], { group_word: string | null; power_system: number; up_to: number }>("SELECT group_word, power_system, up_to FROM plot_title WHERE anilist_id = ?").get(anilistId);
  const byChar = new Map(chars.map((c) => [c.id, c]));
  if (!title) {
    // Разбора нет: главные и второй план AniList, без сюжета (на тайтле не в списке — только главные)
    const members = chars.filter((c) => c.role === "MAIN" || (c.role === "SUPPORTING" && cursorInfo.inList)).map((c): CastMember => ({
      id: 0, entities: [], href: `/characters/${c.id}`, anilistCharId: c.id, name: c.nameRu ?? c.name, native: c.native, role: c.role, image: c.image, lookLabel: null,
      description: null, goal: null, groups: [], aka: [], firstEp: null, voice: c.voice,
    }));
    return { cursor: cursorInfo, built: false, upTo: 0, groupWord: null, powerSystem: false, members, groups: [], hidden: 0, stats: { relations: 0, events: 0, arcs: 0 } };
  }
  type App = { entity_id: number; role: CharacterRole | null; first_ep: number | null; kind: string; anilist_char_id: number | null; name: string; name_ru: string | null; name_ja: string | null };
  const apps = db.prepare<[number], App>(`
    SELECT a.entity_id, a.role, a.first_ep, e.kind, e.anilist_char_id, e.name, e.name_ru, e.name_ja
    FROM plot_appearance a JOIN plot_entity e ON e.id = a.entity_id WHERE a.anilist_id = ? AND a.first_ep IS NOT NULL`).all(anilistId);
  // Не в списке — только то, что известно до первой серии: главные герои первой серии
  const visible = apps.filter((a) => (k === 0 ? a.first_ep! <= 1 && a.role === "MAIN" : a.first_ep! <= k));
  const shown = new Set<number>();
  const members: CastMember[] = [];
  for (const a of visible) {
    if (a.kind !== "character") continue;
    const ids = identityOf(a.entity_id, cursor);
    const main = canonical(ids);
    if (shown.has(main)) continue;
    shown.add(main);
    const e = entity(main)!;
    const c = e.anilist_char_id ? byChar.get(e.anilist_char_id) : undefined;
    const img = ids.map((x) => currentImage(x, cursor)).filter((x) => x !== null).sort((x, y) => (x!.from_ep ?? 0) - (y!.from_ep ?? 0)).at(-1) ?? null;
    const note = k > 0 ? noteOf(ids, cursor) : null;
    members.push({
      id: main, entities: ids, href: hrefOf(e), anilistCharId: e.anilist_char_id, name: c?.nameRu ?? nameOf(e), native: c?.native ?? e.name_ja,
      role: (c?.role ?? apps.find((x) => x.entity_id === main)?.role ?? a.role ?? "SUPPORTING") as CharacterRole,
      image: img?.url ?? null, lookLabel: img?.label ?? null, description: note?.description ?? null, goal: note?.goal ?? null,
      groups: groupsOf(ids, cursor).filter((g) => !g.past).map(({ id, name, role }) => ({ id, name, role })),
      aka: ids.filter((x) => x !== main).map((x) => nameOf(entity(x)!)), firstEp: Math.min(...apps.filter((x) => ids.includes(x.entity_id)).map((x) => x.first_ep!)),
      voice: c?.voice ?? null,
    });
  }
  const order: Record<CharacterRole, number> = { MAIN: 0, SUPPORTING: 1, BACKGROUND: 2 };
  members.sort((a, b) => order[a.role] - order[b.role] || (a.firstEp ?? 0) - (b.firstEp ?? 0));
  const groupCount = new Map<number, { name: string; count: number }>();
  for (const m of members) for (const g of m.groups) groupCount.set(g.id, { name: g.name, count: (groupCount.get(g.id)?.count ?? 0) + 1 });
  const hidden = apps.filter((a) => a.kind === "character" && !visible.includes(a)).length;
  const events = visibleEvents(anilistId, k);
  const relations = db.prepare<[number, number], { n: number }>("SELECT COUNT(*) AS n FROM plot_relation WHERE anilist_id = ? AND COALESCE(revealed_ep, from_ep, 0) <= ?").get(anilistId, k)!.n;
  return {
    cursor: cursorInfo, built: true, upTo: title.up_to, groupWord: title.group_word, powerSystem: Boolean(title.power_system),
    members, groups: [...groupCount].map(([id, g]) => ({ id, ...g })).sort((a, b) => b.count - a.count), hidden,
    stats: { relations, events: events.length, arcs: new Set(events.map((e) => e.data.arc).filter(Boolean)).size },
  };
}

/**
 * Имена персонажей франшизы для разметки текста о сериях ≤ upTo. Персонаж, которого зритель ещё не видел, — spoiler:
 * его карточка размыта. Имя склеенного персонажа ведёт на того, кем его знали на момент текста.
 */
export async function nameRefs(userId: number, anilistId: number, upTo: number): Promise<NameRefs> {
  const cursor = viewerCursor(userId);
  const own = (await titleCursor(userId, anilistId)).ep;
  type Row = { entity_id: number; alias: string; anilist_id: number | null; revealed_ep: number | null; anilist_char_id: number | null; look: string | null; main: number };
  // Основное имя размечаем всегда, даже со строчной («человек с ножом»). Размечаем собственные имена: основное и имена/прозвища с большой буквы; титулы, облики и нарицательные слова — нет
  const rows = db.prepare<[number], Row>(`
    SELECT al.entity_id, al.alias, al.anilist_id, al.revealed_ep, e.anilist_char_id, al.look, 0 AS main FROM plot_alias al JOIN plot_entity e ON e.id = al.entity_id
    WHERE al.entity_id IN (SELECT entity_id FROM plot_appearance WHERE anilist_id = ?1 AND first_ep IS NOT NULL) AND e.kind = 'character'
      AND COALESCE(al.kind, 'имя') IN ('имя', 'прозвище')
    UNION ALL
    SELECT e.id, COALESCE(e.name_ru, e.name), a.anilist_id, a.first_ep, e.anilist_char_id, NULL, 1 FROM plot_entity e JOIN plot_appearance a ON a.entity_id = e.id
    WHERE a.anilist_id = ?1 AND a.first_ep IS NOT NULL AND e.kind = 'character'`).all(anilistId);
  type LookRow = { look: string; label: string; label_en: string | null };
  const looksOf = new Map<number, LookRow[]>();
  const looks = (e: number) => looksOf.get(e) ?? looksOf.set(e, db.prepare<[number], LookRow>("SELECT look, label, label_en FROM plot_look WHERE entity_id = ?").all(e)).get(e)!;
  // Картинка облика, которую зритель уже может видеть
  const imageOf = (e: number, look: string) => db.prepare<[number, string], { url: string; anilist_id: number | null; from_ep: number | null }>(
    "SELECT url, anilist_id, from_ep FROM plot_image WHERE entity_id = ? AND look = ? ORDER BY source = 'fandom' DESC").all(e, look)
    .find((i) => i.from_ep !== null && seen(cursor, i.anilist_id, i.from_ep))?.url ?? null;
  const out: NameRef[] = [];
  // В тексте полное имя пишут коротко: «Римуру Темпест» → «Римуру», «Шизуэ Идзава» → «Шизуэ». Прилагательное — не имя
  // («Великий мудрец», «Небесный дракон»). Общая у двух персонажей часть («Темпест») разметкой пропускается и так
  const short = rows.filter((r) => r.main && isProperName(r.alias) && r.alias.trim().split(/\s+/).length > 1)
    .map((r) => ({ ...r, alias: r.alias.trim().split(/\s+/)[0] }))
    .filter((r) => r.alias.length >= 3 && !/(ий|ый|ой|ая|яя|ое|ее|ые|ие)$/i.test(r.alias));
  // Строчное основное имя из одного слова — нарицательное («официантка»): не размечаем; «человек с ножом» — да
  const usable = [...rows, ...short].filter((x) => (x.main ? isProperName(x.alias) || x.alias.trim().includes(" ") : isProperName(x.alias)));
  for (const r of usable) {
    const ep = r.revealed_ep ?? 0;
    const look = aliasLook(r.alias, r.look, looks(r.entity_id));
    const as = look ? { name: r.alias, image: imageOf(r.entity_id, look), lookLabel: looks(r.entity_id).find((l) => l.look === look)!.label } : null;
    // Текст о серии upTo этого тайтла не может знать имён, раскрытых позже; предыстории — целиком
    if (r.anilist_id === anilistId && ep > upTo) continue;
    out.push({ alias: r.alias, entity: r.entity_id, href: hrefOf({ id: r.entity_id, anilist_char_id: r.anilist_char_id }), spoiler: r.anilist_id === anilistId ? ep > own : !seen(cursor, r.anilist_id, ep), anilistId: r.anilist_id, revealedEp: ep, as });
  }
  const cards: Record<number, NameCard> = {};
  for (const e of new Set(out.filter((r) => !r.spoiler).map((r) => r.entity))) {
    const c = nameCard(e, anilistId, cursor);
    if (c) cards[e] = c;
  }
  return { refs: out, cards, cursor: own };
}

/** Карточка самого персонажа (не склеенного с ним) на курсор зрителя: картинки — по сериям, склейка — с серией раскрытия. */
function nameCard(entityId: number, anilistId: number, cursor: Map<number, number>): NameCard | null {
  const e = entity(entityId);
  if (!e) return null;
  const app = db.prepare<[number, number], { role: CharacterRole | null; first_ep: number | null }>(
    "SELECT role, first_ep FROM plot_appearance WHERE entity_id = ? AND anilist_id = ?").get(entityId, anilistId);
  const note = noteOf([entityId], cursor);
  const ids = identityOf(entityId, cursor);
  const main = canonical(ids);
  let mergedInto: NameCard["mergedInto"] = null;
  if (main !== entityId) {
    const m = entity(main)!;
    const r = db.prepare<[number, number, number, number], { anilist_id: number; revealed_ep: number }>(
      "SELECT anilist_id, revealed_ep FROM plot_identity WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").get(entityId, main, main, entityId);
    mergedInto = { name: nameOf(m), href: hrefOf(m), ep: r && r.anilist_id === anilistId ? r.revealed_ep : 0 };
  }
  return {
    name: nameOf(e), native: e.name_ja, href: hrefOf(e), role: app?.role ?? "SUPPORTING",
    description: note?.description ?? null, goal: note?.goal ?? null,
    groups: groupsOf([entityId], cursor).filter((g) => !g.past).map(({ id, name, role }) => ({ id, name, role })),
    firstEp: app?.first_ep ?? null,
    images: imagesOf(entityId, cursor).visible.map((i) => ({ url: i.url, label: i.label, ep: i.anilist_id === anilistId ? i.from_ep ?? 0 : 0 })),
    mergedInto,
  };
}

// ---------------------------------------------------------------- события

type EventRow = {
  id: number; key: string; anilist_id: number; title: string; summary: string | null; kind: string | null;
  ep_from: number | null; ep_to: number | null; revealed_ep: number | null; major: number; data: { course?: string; arc?: string; motives?: Record<string, string> };
};
type RawEvent = Omit<EventRow, "data"> & { data: string | null };
const EVENT_COLS = "id, key, anilist_id, title, summary, kind, ep_from, ep_to, revealed_ep, major, data";
const parseEvent = (e: RawEvent): EventRow => ({ ...e, data: e.data ? JSON.parse(e.data) : {} });
const eventEp = (e: { revealed_ep: number | null; ep_to: number | null; ep_from: number | null }) => e.revealed_ep ?? e.ep_to ?? e.ep_from ?? 0;

/** События тайтла, которые зритель уже видел (по серии раскрытия), по порядку серий. */
function visibleEvents(anilistId: number, k: number): EventRow[] {
  return db.prepare<[number], RawEvent>(`SELECT ${EVENT_COLS} FROM plot_event WHERE anilist_id = ? AND key IS NOT NULL ORDER BY ep_from, id`).all(anilistId)
    .filter((e) => eventEp(e) <= k).map(parseEvent);
}

/** Связи «почему» события: причины (в него) и последствия (из него), видимые на курсор; сколько последствий скрыто. */
function linksOf(eventId: number, k: number, cursor: Map<number, number>) {
  type L = { kind: string; revealed_ep: number | null; other: number; dir: string };
  const rows = db.prepare<[number], L>(`
    SELECT kind, revealed_ep, from_event AS other, 'in' AS dir FROM plot_event_link WHERE to_event = ?1
    UNION ALL SELECT kind, revealed_ep, to_event, 'out' FROM plot_event_link WHERE from_event = ?1`).all(eventId);
  const ev = db.prepare<[number], { key: string; anilist_id: number; title: string; ep_from: number | null; ep_to: number | null; revealed_ep: number | null }>(
    "SELECT key, anilist_id, title, ep_from, ep_to, revealed_ep FROM plot_event WHERE id = ?");
  const causes: EventLinkInfo[] = [];
  const consequences: EventLinkInfo[] = [];
  let hidden = 0;
  for (const r of rows) {
    const o = ev.get(r.other);
    if (!o) continue;
    // Причина из предыстории видна по её тайтлу, своя и последствие — по курсору
    const visible = (r.revealed_ep ?? 0) <= k && seen(cursor, o.anilist_id, eventEp(o));
    if (!visible) {
      if (r.dir === "out") hidden++;
      continue;
    }
    const info = { kind: r.kind, note: null, key: o.key, anilistId: o.anilist_id, title: o.title, ep: o.ep_from };
    (r.dir === "in" ? causes : consequences).push(info);
  }
  return { causes, consequences, hidden };
}

/** Участники события — как зритель знает их сейчас (склеенные — под главным именем); группы не показываем. */
function participantsOf(eventId: number, cursor: Map<number, number>): EventBrief["participants"] {
  const out: EventBrief["participants"] = [];
  for (const p of db.prepare<[number], { entity_id: number; role: string | null }>("SELECT entity_id, role FROM plot_event_participant WHERE event_id = ?").all(eventId)) {
    const main = canonical(identityOf(p.entity_id, cursor));
    const e = entity(main);
    if (!e || e.kind !== "character" || out.some((x) => x.id === main)) continue;
    out.push({ id: main, name: nameOf(e), href: hrefOf(e), image: currentImage(main, cursor)?.url ?? null, role: p.role });
  }
  return out;
}

function briefOf(e: EventRow, k: number, cursor: Map<number, number>): EventBrief & { hiddenConsequences: number } {
  const l = linksOf(e.id, k, cursor);
  return {
    key: e.key, anilistId: e.anilist_id, title: e.title, summary: e.summary, kind: e.kind, epFrom: e.ep_from, epTo: e.ep_to,
    arc: e.data.arc || null, major: Boolean(e.major), participants: participantsOf(e.id, cursor),
    causes: l.causes, consequences: l.consequences, hiddenConsequences: l.hidden,
  };
}

/** События тайтла на курсор — по аркам, в порядке серий. */
export async function titleEvents(userId: number, anilistId: number): Promise<TitleEvents> {
  const cursorInfo = await titleCursor(userId, anilistId);
  const cursor = viewerCursor(userId);
  cursor.set(anilistId, cursorInfo.ep);
  const all = db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM plot_event WHERE anilist_id = ? AND key IS NOT NULL").get(anilistId)!.n;
  const events = visibleEvents(anilistId, cursorInfo.ep);
  const arcs: TitleEvents["arcs"] = [];
  for (const e of events) {
    const b = briefOf(e, cursorInfo.ep, cursor);
    const last = arcs.at(-1);
    if (last && last.name === b.arc) last.events.push(b);
    else arcs.push({ name: b.arc, events: [b] });
  }
  return { cursor: cursorInfo, arcs, hidden: all - events.length };
}

/** Страница события. После курсора — только серия, в которой оно раскроется. */
export async function eventDetails(userId: number, anilistId: number, key: string): Promise<EventDetails> {
  const cursorInfo = await titleCursor(userId, anilistId);
  const cursor = viewerCursor(userId);
  const k = cursorInfo.ep;
  cursor.set(anilistId, k);
  const raw = db.prepare<[number, string], RawEvent>(`SELECT ${EVENT_COLS} FROM plot_event WHERE anilist_id = ? AND key = ? ORDER BY id DESC`).get(anilistId, key);
  if (!raw) throw new ApiError(404, "Событие не найдено");
  const e = parseEvent(raw);
  if (eventEp(e) > k) {
    return {
      key, anilistId, title: "", summary: null, kind: null, epFrom: null, epTo: null, arc: null, major: false, participants: [], causes: [], consequences: [],
      course: null, motives: [], hiddenConsequences: 0, sources: [], hiddenUntil: eventEp(e), cursor: cursorInfo,
    };
  }
  const b = briefOf(e, k, cursor);
  const motives: EventDetails["motives"] = [];
  for (const [id, text] of Object.entries(e.data.motives ?? {})) {
    const p = entity(canonical(identityOf(Number(id), cursor)));
    if (p) motives.push({ id: p.id, name: nameOf(p), href: hrefOf(p), text });
  }
  // Источник — подробные тексты корпуса о сериях события
  const sources = db.prepare<[number, number, number], { source: string }>(
    "SELECT DISTINCT source FROM episode_text WHERE anilist_id = ? AND ep BETWEEN ? AND ? AND retracted_at IS NULL AND depth != 'teaser'")
    .all(anilistId, e.ep_from ?? 0, e.ep_to ?? e.ep_from ?? 0).map((r) => r.source);
  return { ...b, course: e.data.course || null, motives, sources, hiddenUntil: null, cursor: cursorInfo };
}

// ---------------------------------------------------------------- карта персонажей

/** Персонажи состава на курсор и отношения между ними (склеенные — под главным именем, кончившиеся — с серией конца). */
export async function relationMap(userId: number, anilistId: number): Promise<RelationMap> {
  const cast = await titleCast(userId, anilistId);
  const k = cast.cursor.ep;
  const cursor = viewerCursor(userId);
  cursor.set(anilistId, k);
  const byEntity = new Map<number, number>();
  for (const m of cast.members) for (const e of m.entities.length ? m.entities : [m.id]) byEntity.set(e, m.id);
  type Row = { a: number; b: number; kind: string; label: string | null; from_ep: number | null; ended_ep: number | null; revealed_ep: number | null };
  const edges: RelationMap["edges"] = [];
  for (const r of db.prepare<[number], Row>("SELECT a, b, kind, label, from_ep, ended_ep, revealed_ep FROM plot_relation WHERE anilist_id = ? ORDER BY from_ep").all(anilistId)) {
    if ((r.revealed_ep ?? r.from_ep ?? 0) > k) continue;
    const a = byEntity.get(r.a), b = byEntity.get(r.b);
    if (a === undefined || b === undefined || a === b) continue;
    edges.push({ a, b, kind: r.kind, label: r.label, fromEp: r.from_ep, endedEp: r.ended_ep !== null && r.ended_ep <= k ? r.ended_ep : null });
  }
  return {
    cursor: cast.cursor, groupWord: cast.groupWord,
    nodes: cast.members.map((m) => ({ id: m.id, name: m.name, href: m.href, image: m.image, role: m.role, groups: m.groups.map(({ id, name }) => ({ id, name })), description: m.description })),
    edges,
  };
}
