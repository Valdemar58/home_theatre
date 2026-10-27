import "server-only";
import type { JsonSchema } from "@/lib/json-lite";
import { TIER } from "@/lib/llm-tier";
import {
  ABILITY_STATUS, ALIAS_KINDS, ENTITY_KINDS, EVENT_KINDS, IMPORTANCE, LINK_KINDS, LOOK_KINDS, RELATION_KINDS,
  emptyGraph, foldGraph, graphForPrompt, sameName, slug, type Graph, type GraphDelta, type GPersona,
} from "@/lib/plot-graph";
import type { CharacterRole, CorpusProgress } from "@/lib/types";
import { getDetails, type AnilistDetails } from "./anilist";
import { db, now } from "./db";
import { bestOutput, hashOf, recordOutput, type Known } from "./knowledge";
import { bestRouteTier, runTask } from "./llm";
import { getLlmConfig } from "./llm-config";
import { prequelChain } from "./plot";
import { checkLooks, fandomLooks } from "./plot-looks";
import { deepPlan, type DeepPlan } from "./plot-deep";
import { seedCharacters, titleCharacters } from "./plot-graph";
import { registerHandler } from "./tasks";

// Граф сюжета из корпуса серий (задача plot_graph, идея #79): теми же порциями, что пересказ сезона, слепо по порядку.
// Порция видит граф после прошлых порций (и предысторий франшизы) и тексты своих серий, отдаёт дополнения — каждое
// со своей серией. Дополнения хранятся в llm_output (subject graph:<id>:<последняя серия>), хэш входа — цепочкой
// от хэша пересказа: поменялся текст серии — пересчитывается её порция и всё после. Таблицы plot_* — производные:
// materializeGraph переписывает строки тайтла с source = 'graph' целиком.

const PROMPT_V = 3;
const INPUT_V = 2;
const SOURCE = "graph";

const subject = (id: number, upTo: number) => `graph:${id}:${upTo}`;
const opts = (inputHash: string) => ({ inputHash, policy: "tier-first" as const, staleOk: false });

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const int = (description?: string): JsonSchema => ({ type: "integer", minimum: 0, ...(description ? { description } : {}) });
const en = (values: readonly string[], description?: string): JsonSchema => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema =>
  ({ type: "object", properties, required: Object.keys(properties), ...(description ? { description } : {}) });
const arr = (items: JsonSchema, maxItems: number, description?: string): JsonSchema => ({ type: "array", items, maxItems, ...(description ? { description } : {}) });

const KEY = "ключ: латиницей, коротко и навсегда (rimuru, benimaru, ogre-clan); у известных — как в состоянии";

const SCHEMA: JsonSchema = obj({
  personas: arr(obj({
    key: str(KEY), kind: en(ENTITY_KINDS), importance: en(IMPORTANCE),
    name_ru: str("как зритель называет его сейчас"), name_en: str("как в английском тексте"), name_ja: str("по-японски, если известно, иначе пусто"),
    description_ru: str("1–2 предложения: кто это на конец последней данной серии, только по увиденному"),
    goal_ru: str("чего хочет сейчас, коротко; не ясно — пусто"),
    first_ep: int("серия первого появления"),
  }), 40, "только те, кто действует в новых сериях: новые и прежние, у прежних — обновлённое описание; остальных не повторяй"),
  aliases: arr(obj({
    key: str(), alias: str("по-русски"), kind: en(ALIAS_KINDS), who_ru: str("кто так зовёт; все — пусто"), ep: int(),
    look: str("ключ облика из looks, если имя относится к особому облику (прошлая жизнь, маскировка, форма); иначе пусто"),
  }), 60,
    "новые имена, прозвища, титулы и названия обликов, с серии, где зритель их узнал"),
  looks: arr(obj({
    key: str(), look: str("ключ облика латиницей: slime, human-form, armored-titan"), label_ru: str(), label_en: str("коротко по-английски, как подписали бы на вики: Slime, Human form"),
    appearance_en: str("как выглядит в кадре, по-английски, 5–12 слов: «blue slime blob», «silver-haired youth in a mask»"),
    kind: en(LOOK_KINDS), ep: int("серия, где облик впервые показан"),
  }), 20, "облики, которые показаны впервые: как персонаж выглядит в кадре сейчас, другая форма, маскировка, прошлая жизнь"),
  identities: arr(obj({ a: str(), b: str(), ep: int("серия, где зритель это узнал"), note_ru: str() }), 10,
    "раскрыто, что два персонажа из списка — одно лицо (например, человек в маске оказался известным героем)"),
  members: arr(obj({ key: str(), group: str("ключ группы"), role_ru: str(), from_ep: int(), to_ep: int("ушёл из группы в серии; иначе 0") }), 40),
  relations: arr(obj({
    a: str(), b: str(), kind: en(RELATION_KINDS, "a по отношению к b: «служит» — a служит b"), label_ru: str("уточнение: «брат», «приёмный отец»"),
    from_ep: int(), ended_ep: int("отношение кончилось в серии; иначе 0"),
  }), 40, "новые отношения и конец прежних"),
  events: arr(obj({
    key: str("ключ события латиницей, новый для каждого события"), title_ru: str("коротко: «Орки сжигают деревню огров»"),
    summary_ru: str("1–2 предложения"), course_ru: str("как шло: 2–4 предложения"), kind: en(EVENT_KINDS),
    major: { type: "boolean", description: "важно для сюжета сезона" }, ep_from: int(), ep_to: int(), arc_ru: str("арка или этап; нет — пусто"),
    participants: arr(obj({ key: str(), role_ru: str("роль в событии: нападает, защищает, свидетель"), motive_ru: str("зачем, если серия это показала; иначе пусто") }), 30),
  }), 10, "события новых серий: важные для сюжета, не каждую реплику"),
  links: arr(obj({ from: str("ключ события-причины"), to: str("ключ события-следствия"), kind: en(LINK_KINDS), note_ru: str() }), 30,
    "почему случилось событие: связи от прежних или новых событий к новым"),
  abilities: arr(obj({ key: str("ключ персонажа, у которого эта способность"), name_ru: str(), text_ru: str("что делает, коротко"), status: en(ABILITY_STATUS), ep: int() }), 8,
    "способности, если в тайтле есть система сил: только важные для сюжета, новые и сменившие статус; мелкие навыки не нужны"),
  group_word_ru: str("как в тайтле называют группы во множественном числе: «кланы», «команды»; групп нет — пусто"),
  power_system: { type: "boolean", description: "есть ли в тайтле система сил (магия, навыки, техники)" },
});

const SYSTEM = `Ты ведёшь граф сюжета аниме серия за серией, как зритель, который смотрит впервые: кто есть кто, как их зовут, как выглядят, кто с кем связан, что произошло и почему.
Тебе дают граф после прошлых серий и тексты следующих серий. Верни только дополнения по новым сериям.
Правила:
- Только по данным текстам. Ничего не додумывай и не бери из своих знаний о тайтле.
- Ты не знаешь будущего. Чего зритель ещё не знает — того нет: ни имён, ни родства, ни раскрытий личности, ни будущих форм.
- Если зритель знает персонажа под другим именем или в маске и не знает, кто это, — это ОТДЕЛЬНЫЙ персонаж со своим ключом («человек в маске»). Связь «это одно лицо» — в identities, только в серии, где это раскрыто.
- Ключ персонажа не меняется никогда. У известных — ключ из состояния, у новых — новый.
- name_en — как в английском тексте; если персонаж есть в списке AniList — ровно как там.
- Имена из словаря Shikimori — строго как там; остальные японские — по Поливанову; одного персонажа везде одинаково.
- looks — как персонаж выглядит в кадре. Первый облик заметного персонажа — kind «обычный». Новый облик — только с серии, где его показали: «принял человеческий облик», «превратился в титана». Прошлая жизнь, воспоминание, другой человек до перерождения — kind «прошлое», это не нынешний облик.
- events — 2–4 на серию, главное. Ключ — новый для каждого события. links — только если связь видна из текста.
- Пиши сжато: описания и уточнения — коротко, без повторов. Не повторяй того, что уже есть в графе: имена, облики, отношения, события — только новое.
- Серии (ep, first_ep, from_ep, ep_from) — номера из заголовков «### Серия N».`;

// ---------------------------------------------------------------- франшиза и цепочка хэшей

type Title = { d: AnilistDetails; plan: DeepPlan; hashes: string[]; known: Known<GraphDelta>[] };

/** Сезоны франшизы до этого включительно (от раннего), с цепочкой хэшей графа: предыстория меняет хэш продолжения. */
async function franchise(id: number): Promise<Title[]> {
  const d = await getDetails(id);
  const chain = [...(await prequelChain(d)), d];
  const out: Title[] = [];
  let pre = "none";
  for (const t of chain) {
    const plan = deepPlan(t.id);
    const hashes = plan.hashes.map((h) => hashOf([h, INPUT_V, pre]));
    const known: Known<GraphDelta>[] = [];
    for (const [i, b] of plan.batches.entries()) {
      const k = bestOutput<GraphDelta>("plot_graph", subject(t.id, b.at(-1)!), opts(hashes[i]));
      if (!k?.fresh) break;
      known.push(k);
    }
    out.push({ d: t, plan, hashes, known });
    pre = hashOf([pre, t.id, hashes.slice(0, known.length)]);
  }
  return out;
}

const fold = (titles: Title[], base = emptyGraph()) =>
  foldGraph(titles.flatMap((t) => t.known.map((k, i) => ({ eps: t.plan.batches[i], delta: k.value, title: t.d.id }))), base);

/** Граф франшизы, досчитанный до этого тайтла (без недостроенных порций). */
export async function titleGraph(id: number): Promise<{ graph: Graph; root: number; titles: Title[] }> {
  const titles = await franchise(id);
  return { graph: fold(titles), root: titles[0].d.id, titles };
}

/**
 * Досчитать граф тайтла: порции, которых нет или вход которых изменился (пересказ сезона уже должен быть).
 * Возвращает число вызовов модели.
 */
export async function buildGraph(id: number, signal: AbortSignal, onBatch?: (done: number, total: number) => void): Promise<number> {
  const titles = await franchise(id);
  const me = titles.at(-1)!;
  const total = me.plan.batches.length;
  const routeTier = await bestRouteTier("plot_graph");
  const weak = getLlmConfig().upgrade.plot_graph ? me.known.findIndex((k) => k.prov.tier < routeTier) : -1;
  if (weak >= 0) me.known = me.known.slice(0, weak);
  onBatch?.(me.known.length, total);
  if (me.known.length === total) return 0;
  const chars = await titleCharacters(id, me.d.idMal).catch(() => []);
  const roster = chars.filter((c) => c.role !== "BACKGROUND").slice(0, 60);
  const head = [
    `Тайтл: ${me.d.title.english ?? me.d.title.romaji ?? ""}${me.d.title.native ? ` (${me.d.title.native})` : ""}`,
    roster.length ? `Список персонажей AniList (англ. / яп. / рус.) — только для написания имён, не для сюжета:\n${roster.map((c) => `${c.name} / ${c.native ?? ""} / ${c.nameRu ?? ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const localOnly = getLlmConfig().tasks.plot_graph === "local" || getLlmConfig().mode === "local";
  let calls = 0;
  for (let i = me.known.length; i < total; i++) {
    signal.throwIfAborted();
    const b = me.plan.batches[i];
    const graph = fold(titles);
    const user = [
      head,
      graph.personas.size ? `Граф после прошлых серий:\n${graphForPrompt(graph)}` : "Это начало: графа ещё нет.",
      `Новые серии (${b[0]}–${b.at(-1)}):`,
      ...b.map((ep) => { const e = me.plan.inputs.get(ep)!; return `### Серия ${ep}${e.title ? `: ${e.title}` : ""}${e.filler ? " [филлер]" : ""}\n${e.text}`; }),
    ].join("\n\n");
    const res = await runTask<GraphDelta>("plot_graph", { schema: SCHEMA, system: SYSTEM, user, maxTokens: 40_000, timeoutMs: 900_000, minTier: localOnly ? 0 : TIER.cheap });
    calls++;
    const id_ = recordOutput("plot_graph", subject(id, b.at(-1)!), res, res.value, { schemaV: 1, promptV: PROMPT_V, inputHash: me.hashes[i] });
    me.known.push({ value: res.value, fresh: true, prov: { id: id_, provider: res.provider, model: res.model, tier: res.tier, createdAt: now(), inputHash: me.hashes[i], schemaV: 1 } });
    onBatch?.(i + 1, total);
  }
  return calls;
}

// ---------------------------------------------------------------- запись в таблицы

const ROLE: Record<GPersona["importance"], CharacterRole> = { "главный": "MAIN", "второй план": "SUPPORTING", "эпизод": "BACKGROUND" };

/**
 * Граф тайтла → таблицы plot_*. Сущность персонажа: ключ франшизы (plot_key) → персонаж AniList с тем же именем
 * (ещё не занятый другим ключом) → новая сущность. Имя сверяется только с основным именем AniList: альтернативные
 * имена там бывают спойлером («Бронированный титан» у Райнера).
 */
export async function materializeGraph(id: number): Promise<{ entities: number; events: number }> {
  const { graph: g, root, titles } = await titleGraph(id);
  const me = titles.at(-1)!;
  const chars = await titleCharacters(id, me.d.idMal).catch(() => []);
  seedCharacters(id, chars);
  const keyRows = new Map(db.prepare<[number], { key: string; entity_id: number }>("SELECT key, entity_id FROM plot_key WHERE root_id = ?").all(root).map((r) => [r.key, r.entity_id]));
  const claimed = new Set(keyRows.values());
  const t = now();
  const entityOf = new Map<string, number>();
  const newEntity = db.prepare<[string, string, string | null, string | null, number, number], { id: number }>(
    "INSERT INTO plot_entity (kind, name, name_ru, name_ja, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id");
  for (const p of g.personas.values()) {
    let e = keyRows.get(p.key) ?? null;
    if (e === null && p.kind === "персонаж") {
      const c = chars.find((c) => (sameName(p.name_en, c.name) || (c.native !== null && sameName(p.name_ja, c.native)) || (c.nameRu !== null && sameName(p.name_ru, c.nameRu))));
      const hit = c ? db.prepare<[number], { id: number }>("SELECT id FROM plot_entity WHERE anilist_char_id = ?").get(c.id)?.id ?? null : null;
      if (hit !== null && !claimed.has(hit)) e = hit;
    }
    if (e === null) e = newEntity.get(p.kind === "группа" ? "group" : "character", p.name_en || p.name_ru, p.name_ru || null, p.name_ja || null, t, t)!.id;
    if (!keyRows.has(p.key)) db.prepare("INSERT OR IGNORE INTO plot_key (root_id, key, entity_id) VALUES (?, ?, ?)").run(root, p.key, e);
    claimed.add(e);
    entityOf.set(p.key, e);
    // Своё имя — у сущностей без AniList; у AniList-персонажей русское имя Shikimori, иначе из графа
    db.prepare("UPDATE plot_entity SET name_ru = CASE WHEN anilist_char_id IS NULL OR name_ru IS NULL THEN ? ELSE name_ru END, updated_at = ? WHERE id = ?")
      .run(p.name_ru || null, t, e);
  }
  const E = (key: string) => entityOf.get(key)!;
  const mine = <T extends { title: number }>(xs: Iterable<T>) => [...xs].filter((x) => x.title === id);
  let events = 0;
  db.exec("BEGIN");
  try {
    const eventIds = db.prepare<[number, string], { id: number }>("SELECT id FROM plot_event WHERE anilist_id = ? AND source = ?").all(id, SOURCE).map((r) => r.id);
    for (const ev of eventIds) {
      db.prepare("DELETE FROM plot_event_participant WHERE event_id = ?").run(ev);
      db.prepare("DELETE FROM plot_event_link WHERE from_event = ? OR to_event = ?").run(ev, ev);
    }
    for (const table of ["plot_event", "plot_alias", "plot_relation", "plot_look", "plot_identity", "plot_member", "plot_ability"]) {
      db.prepare(`DELETE FROM ${table} WHERE anilist_id = ? AND source = ?`).run(id, SOURCE);
    }
    db.prepare("DELETE FROM plot_note WHERE anilist_id = ?").run(id);

    // Появление в тайтле — с первой порции, где персонаж был; роль — из AniList, если он там есть
    const firstHere = new Map<string, number>();
    for (const n of mine(g.notes)) firstHere.set(n.key, Math.min(firstHere.get(n.key) ?? Infinity, n.from));
    for (const p of g.personas.values()) if (p.title === id) firstHere.set(p.key, Math.min(firstHere.get(p.key) ?? Infinity, p.first_ep));
    const app = db.prepare(`INSERT INTO plot_appearance (entity_id, anilist_id, role, first_ep, source) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (entity_id, anilist_id) DO UPDATE SET first_ep = excluded.first_ep, role = COALESCE(plot_appearance.role, excluded.role)`);
    for (const [key, ep] of firstHere) app.run(E(key), id, ROLE[g.personas.get(key)!.importance], ep, SOURCE);

    const note = db.prepare("INSERT OR REPLACE INTO plot_note (entity_id, anilist_id, up_to, description, goal) VALUES (?, ?, ?, ?, ?)");
    for (const n of mine(g.notes)) note.run(E(n.key), id, n.upTo, n.description_ru, n.goal_ru || null);
    const alias = db.prepare("INSERT OR IGNORE INTO plot_alias (entity_id, alias, lang, anilist_id, from_ep, revealed_ep, source, kind, who, look) VALUES (?, ?, 'ru', ?, ?, ?, ?, ?, ?, ?)");
    for (const a of mine(g.aliases)) alias.run(E(a.key), a.alias, id, a.ep, a.revealed, SOURCE, a.kind, a.who_ru || null, a.look ? slug(a.look) : null);
    const look = db.prepare("INSERT OR IGNORE INTO plot_look (entity_id, anilist_id, look, label, label_en, appearance, kind, from_ep, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const l of mine(g.looks)) look.run(E(l.key), id, l.look, l.label_ru, l.label_en || null, l.appearance_en || null, l.kind, l.revealed, SOURCE);
    const ident = db.prepare("INSERT OR IGNORE INTO plot_identity (a, b, anilist_id, revealed_ep, note, source) VALUES (?, ?, ?, ?, ?, ?)");
    for (const i of mine(g.identities)) ident.run(E(i.a), E(i.b), id, i.revealed, i.note_ru || null, SOURCE);
    const member = db.prepare("INSERT INTO plot_member (entity_id, group_id, anilist_id, role, from_ep, to_ep, source) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const m of mine(g.members)) member.run(E(m.key), E(m.group), id, m.role_ru || null, m.from_ep, m.to_ep || null, SOURCE);
    const rel = db.prepare(`INSERT INTO plot_relation (a, b, kind, label, anilist_id, from_ep, ended_ep, revealed_ep, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of mine(g.relations)) rel.run(E(r.a), E(r.b), r.kind, r.label_ru || null, id, r.from_ep, r.ended_ep || null, r.revealed, SOURCE, t);
    const ab = db.prepare("INSERT INTO plot_ability (entity_id, anilist_id, name, text, status, from_ep, source) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const a of mine(g.abilities)) ab.run(E(a.key), id, a.name_ru, a.text_ru || null, a.status, a.revealed, SOURCE);

    const evId = new Map<string, number>();
    const ev = db.prepare<[number, string, string, string, number, number, number, string, number, string, number], { id: number }>(`
      INSERT INTO plot_event (anilist_id, level, kind, title, summary, ep_from, ep_to, revealed_ep, source, data, created_at, key, major)
      VALUES (?, 'event', ?, ?, ?, ?, ?, ?, '${SOURCE}', ?, ?, ?, ?) RETURNING id`);
    const part = db.prepare("INSERT OR IGNORE INTO plot_event_participant (event_id, entity_id, role) VALUES (?, ?, ?)");
    for (const e of mine(g.events.values())) {
      const data = JSON.stringify({ course: e.course_ru, arc: e.arc_ru, motives: Object.fromEntries(e.participants.filter((p) => p.motive_ru).map((p) => [E(p.key), p.motive_ru])) });
      const row = ev.get(id, e.kind, e.title_ru, e.summary_ru, e.ep_from, e.ep_to, e.revealed, data, t, e.key, Number(e.major))!;
      evId.set(e.key, row.id);
      for (const p of e.participants) part.run(row.id, E(p.key), p.role_ru || null);
      events++;
    }
    // Причина может быть в предыстории: её событие уже записано своим тайтлом
    const earlier = titles.slice(0, -1).map((x) => x.d.id);
    const anyEvent = (key: string) => evId.get(key) ?? (earlier.length ? db.prepare<[string], { id: number }>(
      `SELECT id FROM plot_event WHERE key = ? AND source = '${SOURCE}' AND anilist_id IN (${earlier.join(",")}) ORDER BY id DESC`).get(key)?.id : undefined);
    const link = db.prepare("INSERT OR IGNORE INTO plot_event_link (from_event, to_event, kind, revealed_ep, source) VALUES (?, ?, ?, ?, ?)");
    for (const l of mine(g.links)) {
      const a = anyEvent(l.from), b = anyEvent(l.to);
      if (a && b) link.run(a, b, l.kind, l.revealed, SOURCE);
    }
    db.prepare(`INSERT INTO plot_title (anilist_id, group_word, power_system, up_to, built_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (anilist_id) DO UPDATE SET group_word = excluded.group_word, power_system = excluded.power_system, up_to = excluded.up_to, built_at = excluded.built_at`)
      .run(id, g.groupWord || null, Number(g.powerSystem), me.known.length ? me.plan.batches[me.known.length - 1].at(-1)! : 0, t);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { entities: entityOf.size, events };
}

// ---------------------------------------------------------------- задача «graph»: только граф, без сбора корпуса

const g_ = globalThis as unknown as { __graphProgress?: Map<number, CorpusProgress> };
const progress = (g_.__graphProgress ??= new Map());
export const graphProgress = (id: number) => progress.get(id) ?? null;

registerHandler("graph", {
  noun: "Персонажи и события готовы",
  anilistId: async (key) => Number(key) || null,
  title: async (key) => {
    const d = await getDetails(Number(key));
    return d.title.romaji ?? d.title.english ?? `#${key}`;
  },
  fresh: () => false,
  href: (key) => `/anime/${key}/characters`,
  run: async (key, signal) => {
    const id = Number(key);
    const p: CorpusProgress = { anilistId: id, step: "Персонажи и события", done: 0, total: 1, startedAt: Date.now(), updatedAt: Date.now(), finished: false, found: {}, errors: [], etaSec: null };
    progress.set(id, p);
    const touch = (patch: Partial<CorpusProgress>) => Object.assign(p, patch, { updatedAt: Date.now() });
    // Готовые порции записываются, даже если следующая сорвалась: граф просто короче
    const failed = await buildGraph(id, signal, (done, total) => touch({ done, total })).then(() => null, (e: unknown) => e);
    if (signal.aborted) throw failed;
    const r = await materializeGraph(id);
    if (failed) p.errors.push(`Персонажи и события: ${failed instanceof Error ? failed.message : String(failed)}`);
    touch({ step: "Облики на портретах" });
    await fandomLooks(id, signal).catch((e) => { if (signal.aborted) throw e; p.errors.push(`Fandom: ${e instanceof Error ? e.message : String(e)}`); });
    await checkLooks(id, signal).catch((e) => { if (signal.aborted) throw e; p.errors.push(`Облики: ${e instanceof Error ? e.message : String(e)}`); });
    touch({ step: "готово", finished: true, etaSec: 0 });
    if (failed && !r.entities) throw failed;
    return { summary: `Персонажей и групп: ${r.entities}, событий: ${r.events}` + (failed ? " (граф неполный: порция не удалась)" : ""), isNew: r.entities > 0 };
  },
});
