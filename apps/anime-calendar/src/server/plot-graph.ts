import "server-only";
import { ruNameOf } from "@/lib/characters";
import type { CharacterDetails, CharacterLite, CharacterRole, PlotEventInfo, PlotRelationInfo } from "@/lib/types";
import { gql, MEDIA_FIELDS, toLite, type RawMedia } from "./anilist";
import { cached } from "./cache";
import { characterGlossary } from "./characters";
import { db, now } from "./db";
import { withShikimori } from "./lists";

// Граф сюжета — персонажи (идея #79). Сейчас: персонажи тайтла и карточка персонажа из AniList с русскими именами
// Shikimori; каждый увиденный персонаж — сущность графа (plot_entity) с появлением в тайтле. Отношения и события
// (plot_relation, plot_event) заполнит разбор серий — здесь только чтение с курсором зрителя.

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

type CharacterBase = Omit<CharacterDetails, "relations" | "events">;

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

/** Персонажи тайтла → сущности графа и их появления (источник — AniList). Имена и портрет обновляются. */
export function seedCharacters(animeId: number, chars: CharacterLite[]) {
  const up = db.prepare(`INSERT INTO plot_entity (kind, anilist_char_id, name, name_ru, name_ja, image, created_at, updated_at)
    VALUES ('character', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (anilist_char_id) DO UPDATE SET name = excluded.name, name_ru = COALESCE(excluded.name_ru, plot_entity.name_ru),
      name_ja = excluded.name_ja, image = excluded.image, updated_at = excluded.updated_at`);
  const app = db.prepare(`INSERT INTO plot_appearance (entity_id, anilist_id, role, source)
    SELECT id, ?, ?, 'anilist' FROM plot_entity WHERE anilist_char_id = ?
    ON CONFLICT (entity_id, anilist_id) DO UPDATE SET role = excluded.role`);
  const t = now();
  for (const c of chars) {
    up.run(c.id, c.name, c.nameRu, c.native, c.image, t, t);
    app.run(animeId, c.role, c.id);
  }
}

const entityOf = (anilistCharId: number) =>
  db.prepare<[number], { id: number }>("SELECT id FROM plot_entity WHERE anilist_char_id = ?").get(anilistCharId)?.id ?? null;

/**
 * Отношения персонажа (в обе стороны). cursor — досмотрено до серии по тайтлу: что раскрыто позже, не отдаётся;
 * тайтл, который зритель не начинал, — курсор 0 (из графа ничего не раскрыто).
 */
export function relationsOf(entityId: number, cursor: Map<number, number>): PlotRelationInfo[] {
  type Row = { other: number; char: number | null; name: string; name_ru: string | null; image: string | null; kind: string; label: string | null; anilist_id: number; from_ep: number | null; to_ep: number | null; revealed_ep: number | null };
  return db.prepare<[number], Row>(`
    SELECT CASE WHEN r.a = ?1 THEN r.b ELSE r.a END AS other, e.anilist_char_id AS char, e.name, e.name_ru, e.image,
      r.kind, r.label, r.anilist_id, r.from_ep, r.to_ep, r.revealed_ep
    FROM plot_relation r JOIN plot_entity e ON e.id = CASE WHEN r.a = ?1 THEN r.b ELSE r.a END
    WHERE r.a = ?1 OR r.b = ?1 ORDER BY r.anilist_id, r.from_ep`).all(entityId)
    .filter((r) => (r.revealed_ep ?? r.from_ep ?? 0) <= (cursor.get(r.anilist_id) ?? 0))
    .map((r) => ({ otherId: r.other, otherAnilistId: r.char, otherName: r.name_ru ?? r.name, otherImage: r.image, kind: r.kind, label: r.label, anilistId: r.anilist_id, fromEp: r.from_ep, toEp: r.to_ep }));
}

export function eventsOf(entityId: number, cursor: Map<number, number>): PlotEventInfo[] {
  type Row = { id: number; anilist_id: number; title: string; summary: string | null; kind: string | null; ep_from: number | null; ep_to: number | null; revealed_ep: number | null };
  return db.prepare<[number], Row>(`
    SELECT ev.id, ev.anilist_id, ev.title, ev.summary, ev.kind, ev.ep_from, ev.ep_to, ev.revealed_ep
    FROM plot_event ev JOIN plot_event_participant p ON p.event_id = ev.id
    WHERE p.entity_id = ? AND ev.level != 'moment' ORDER BY ev.anilist_id, ev.ep_from`).all(entityId)
    .filter((r) => (r.revealed_ep ?? r.ep_to ?? r.ep_from ?? 0) <= (cursor.get(r.anilist_id) ?? 0))
    .map((r) => ({ id: r.id, anilistId: r.anilist_id, title: r.title, summary: r.summary, kind: r.kind, epFrom: r.ep_from, epTo: r.ep_to }));
}

/** Карточка персонажа: AniList (появления во всех тайтлах), русские названия, отношения и события до курсора зрителя. */
export async function characterDetails(id: number, cursor: Map<number, number>): Promise<CharacterDetails> {
  const base = structuredClone(await characterBase(id));
  await withShikimori(base.appearances.map((a) => a.media));
  const entity = entityOf(id);
  return { ...base, relations: entity ? relationsOf(entity, cursor) : [], events: entity ? eventsOf(entity, cursor) : [] };
}

/** Курсор зрителя по тайтлам: досмотрено до серии (просмотрено целиком — весь тайтл). */
export function viewerCursor(userId: number): Map<number, number> {
  return new Map(db.prepare<[number], { anilist_id: number; status: string; episodes: number }>(
    "SELECT anilist_id, status, episodes FROM list_entries WHERE user_id = ? AND deleted = 0").all(userId)
    .map((r) => [r.anilist_id, r.status === "completed" ? 1e6 : r.episodes]));
}
