import "server-only";
import { bookKind, type BookDetails, type BookLite, type BookRelation } from "@/lib/books";
import { freshFor } from "@/lib/freshness";
import type { FuzzyDate } from "@/lib/types";
import { gql } from "../anilist";
import { cached, setCached } from "../cache";
import { shikiBook, shikiBookSearch, shikiBooksRu } from "../shikimori";

// Книги на AniList: тот же GraphQL, что у аниме, но type: MANGA (манга, ваншоты, ранобэ). Id у AniList общий.
// Русское название и описание — Shikimori (id манги Shikimori = id MAL).

const LITE_FIELDS = `
  id idMal format status chapters volumes countryOfOrigin isAdult averageScore
  title { romaji english native } coverImage { large color } startDate { year }`;

const DETAILS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: MANGA) {
    ${LITE_FIELDS}
    synonyms description(asHtml: false) bannerImage genres
    endDate { year month day }
    staff(perPage: 8, sort: RELEVANCE) { edges { role node { name { full } } } }
    relations { edges { relationType node { id type format status title { romaji english native } coverImage { large } startDate { year } } } }
    externalLinks { site url }
  }
}`;

type RawLite = {
  id: number; idMal: number | null; format: string | null; status: string | null; chapters: number | null; volumes: number | null;
  countryOfOrigin: string | null; isAdult: boolean; averageScore: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  coverImage: { large: string | null; color: string | null }; startDate: { year: number | null };
};
type RawDetails = RawLite & {
  synonyms: string[] | null; description: string | null; bannerImage: string | null; genres: string[];
  endDate: FuzzyDate;
  staff: { edges: { role: string; node: { name: { full: string } } }[] };
  relations: { edges: { relationType: string; node: { id: number; type: "ANIME" | "MANGA"; format: string | null; status: string | null;
    title: { romaji: string | null; english: string | null; native: string | null }; coverImage: { large: string | null }; startDate: { year: number | null } } }[] };
  externalLinks: { site: string; url: string }[] | null;
};

const toLite = (m: RawLite, ru: string | null = null): BookLite => ({
  id: m.id, idMal: m.idMal, format: m.format, kind: bookKind(m.format, m.countryOfOrigin), status: m.status,
  chapters: m.chapters, volumes: m.volumes, countryOfOrigin: m.countryOfOrigin, isAdult: m.isAdult,
  title: { ...m.title, ru }, coverImage: m.coverImage, year: m.startDate?.year ?? null, averageScore: m.averageScore,
});

/** Страница книги: AniList + русское название и описание Shikimori. Онгоинг — раз в сутки, вышедшая — редко. */
export function bookDetails(id: number): Promise<BookDetails> {
  return cached<BookDetails>(`book:v1:${id}`, { fresh: (b) => freshFor(b), source: "anilist" }, async () => {
    const { Media: m } = await gql<{ Media: RawDetails }>(DETAILS_QUERY, { id });
    const shiki = m.idMal ? await shikiBook(m.idMal).catch(() => null) : null;
    const relations: BookRelation[] = m.relations.edges.map((e) => ({
      relationType: e.relationType, id: e.node.id, type: e.node.type, format: e.node.format, status: e.node.status,
      title: e.node.title.english || e.node.title.romaji || e.node.title.native || String(e.node.id),
      cover: e.node.coverImage.large, year: e.node.startDate.year,
    }));
    const details: BookDetails = {
      ...toLite(m, shiki?.russian ?? null),
      synonyms: m.synonyms ?? [], description: m.description, descriptionRu: shiki?.description ?? null,
      bannerImage: m.bannerImage, genres: m.genres,
      authors: m.staff.edges.map((e) => ({ name: e.node.name.full, role: e.role })),
      relations, links: (m.externalLinks ?? []).map((l) => ({ site: l.site, url: l.url })),
    };
    // Карточка — для списков и поиска без сети
    setCached(`book:lite:${id}`, toLite(m, shiki?.russian ?? null), freshFor(details));
    return details;
  });
}

const SEARCH_QUERY = `
query ($search: String, $malIds: [Int], $format: [MediaFormat]) {
  Page(perPage: 20) { media(type: MANGA, search: $search, idMal_in: $malIds, format_in: $format, sort: [SEARCH_MATCH, POPULARITY_DESC]) { ${LITE_FIELDS} } }
}`;
const CYRILLIC = /[а-яё]/i;

/** Поиск книг: по-русски — через Shikimori (MAL id → AniList), иначе AniList. kind: только ранобэ / только манга. */
export function searchBooks(q: string, kind: "all" | "manga" | "novel" = "all"): Promise<BookLite[]> {
  const query = q.trim();
  if (query.length < 2) return Promise.resolve([]);
  const format = kind === "novel" ? ["NOVEL"] : kind === "manga" ? ["MANGA", "ONE_SHOT"] : undefined;
  return cached(`book-search:${kind}:${query.toLowerCase()}`, { fresh: 86400, source: "anilist" }, async () => {
    let list: RawLite[];
    if (CYRILLIC.test(query)) {
      const malIds = await shikiBookSearch(query, 20);
      if (!malIds.length) return [];
      const d = await gql<{ Page: { media: RawLite[] } }>(SEARCH_QUERY, { malIds, format });
      const order = new Map(malIds.map((id, i) => [id, i]));
      list = d.Page.media.sort((a, b) => (order.get(a.idMal ?? 0) ?? 99) - (order.get(b.idMal ?? 0) ?? 99));
    } else {
      list = (await gql<{ Page: { media: RawLite[] } }>(SEARCH_QUERY, { search: query, format })).Page.media;
    }
    // Русские названия — пачкой (таблица titles_ru — для аниме: MAL id манги и аниме из разных пространств)
    const ru = await shikiBooksRu(list.map((m) => m.idMal).filter((x): x is number => Boolean(x))).catch(() => ({} as Record<number, string | null>));
    return list.map((m) => toLite(m, m.idMal ? ru[m.idMal] ?? null : null));
  });
}

const ANIME_BOOKS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    relations { edges { relationType node { id idMal type format status title { romaji english native } coverImage { large } startDate { year } } } }
  }
}`;

export type AnimeBook = BookRelation & { ru: string | null };

/** Книги, связанные с аниме: первоисточник (SOURCE) первым, потом остальные (спин-оффы, адаптации). */
export function booksForAnime(animeId: number): Promise<AnimeBook[]> {
  return cached(`book-meta:anime:${animeId}`, { fresh: 7 * 86400, source: "anilist" }, async () => {
    type Edge = { relationType: string; node: { id: number; idMal: number | null; type: "ANIME" | "MANGA"; format: string | null; status: string | null;
      title: { romaji: string | null; english: string | null; native: string | null }; coverImage: { large: string | null }; startDate: { year: number | null } } };
    const { Media } = await gql<{ Media: { relations: { edges: Edge[] } } }>(ANIME_BOOKS_QUERY, { id: animeId });
    const books = Media.relations.edges.filter((e) => e.node.type === "MANGA")
      .sort((a, b) => Number(b.relationType === "SOURCE") - Number(a.relationType === "SOURCE"));
    const ru = await shikiBooksRu(books.map((e) => e.node.idMal).filter((x): x is number => Boolean(x))).catch(() => ({} as Record<number, string | null>));
    return books.map((e) => ({
      relationType: e.relationType, id: e.node.id, type: e.node.type, format: e.node.format, status: e.node.status,
      title: e.node.title.english || e.node.title.romaji || e.node.title.native || String(e.node.id),
      cover: e.node.coverImage.large, year: e.node.startDate.year, ru: e.node.idMal ? ru[e.node.idMal] ?? null : null,
    }));
  });
}
