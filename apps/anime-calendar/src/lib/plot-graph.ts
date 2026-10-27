// Граф сюжета (идея #79): чистые правила. Модель идёт по сезону слепо, теми же порциями, что пересказ (plot_deep),
// и на каждую порцию отдаёт дополнения: персонажи, имена, облики, раскрытия «это один человек», группы,
// отношения, события и их причины, способности. Каждое дополнение помечено серией — с неё его знает зритель.

export const ENTITY_KINDS = ["персонаж", "группа"] as const;
export const IMPORTANCE = ["главный", "второй план", "эпизод"] as const;
export const ALIAS_KINDS = ["имя", "прозвище", "титул", "облик"] as const;
export const LOOK_KINDS = ["обычный", "форма", "маскировка", "прошлое"] as const;
export const RELATION_KINDS = ["семья", "друг", "союзник", "служит", "наставник", "соперник", "враг", "любовь", "другое"] as const;
export const EVENT_KINDS = ["бой", "встреча", "решение", "раскрытие", "союз", "предательство", "потеря", "победа", "другое"] as const;
export const LINK_KINDS = ["причина", "повод", "условие", "мотив"] as const;
export const ABILITY_STATUS = ["постоянная", "разовая", "в процессе", "утрачена", "раскрыта частично"] as const;

export type GPersona = {
  key: string; kind: (typeof ENTITY_KINDS)[number]; importance: (typeof IMPORTANCE)[number];
  name_ru: string; name_en: string; name_ja: string;
  /** Кто это — на конец порции, только по увиденному */
  description_ru: string; goal_ru: string; first_ep: number;
};
export type GAlias = { key: string; alias: string; kind: (typeof ALIAS_KINDS)[number]; who_ru: string; ep: number; look?: string };
export type GLook = { key: string; look: string; label_ru: string; label_en: string; appearance_en?: string; kind: (typeof LOOK_KINDS)[number]; ep: number };
export type GIdentity = { a: string; b: string; ep: number; note_ru: string };
export type GMember = { key: string; group: string; role_ru: string; from_ep: number; to_ep: number };
export type GRelation = { a: string; b: string; kind: (typeof RELATION_KINDS)[number]; label_ru: string; from_ep: number; ended_ep: number };
export type GEvent = {
  key: string; title_ru: string; summary_ru: string; course_ru: string; kind: (typeof EVENT_KINDS)[number]; major: boolean;
  ep_from: number; ep_to: number; arc_ru: string;
  participants: { key: string; role_ru: string; motive_ru: string }[];
};
export type GLink = { from: string; to: string; kind: (typeof LINK_KINDS)[number]; note_ru: string };
export type GAbility = { key: string; name_ru: string; text_ru: string; status: (typeof ABILITY_STATUS)[number]; ep: number };

/** Ответ модели на порцию серий */
export type GraphDelta = {
  personas: GPersona[]; aliases: GAlias[]; looks: GLook[]; identities: GIdentity[]; members: GMember[];
  relations: GRelation[]; events: GEvent[]; links: GLink[]; abilities: GAbility[];
  /** Как в тайтле называются группы («команды», «кланы»); пусто — групп нет */
  group_word_ru: string;
  power_system: boolean;
};

/** Описание персонажа на конец порции (from — первая серия порции, где он был) */
export type GNote = { key: string; from: number; upTo: number; description_ru: string; goal_ru: string };

/** Серия раскрытия и тайтл, в котором это узнали (у сезонов франшизы граф общий) */
type At = { revealed: number; title: number };

/** Свёрнутый граф сезона: всё с серией раскрытия (revealed) */
export type Graph = {
  upTo: number;
  personas: Map<string, GPersona & At>;
  notes: (GNote & { title: number })[];
  aliases: (GAlias & At)[];
  looks: (GLook & At)[];
  identities: (GIdentity & At)[];
  members: (GMember & At)[];
  relations: (GRelation & At)[];
  events: Map<string, GEvent & At>;
  links: (GLink & At)[];
  abilities: (GAbility & At)[];
  groupWord: string;
  powerSystem: boolean;
};

export const emptyGraph = (): Graph => ({
  upTo: 0, personas: new Map(), notes: [], aliases: [], looks: [], identities: [], members: [], relations: [],
  events: new Map(), links: [], abilities: [], groupWord: "", powerSystem: false,
});

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
export const slug = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

/**
 * Дополнения порции → граф. Серия каждого дополнения зажимается в серии порции: модель не видела дальше
 * последней, а «раньше первой» — значит, узнали только сейчас. Повтор того же факта не меняет его серию.
 */
export function foldGraph(batches: { eps: number[]; delta: GraphDelta; title?: number }[], base: Graph = emptyGraph()): Graph {
  const g = base;
  for (const { eps, delta: d, title = 0 } of batches) {
    const lo = Math.min(...eps), hi = Math.max(...eps);
    const at = (ep: number) => Math.min(hi, Math.max(lo, Number.isFinite(ep) && ep > 0 ? ep : lo));
    g.upTo = Math.max(g.upTo, hi);
    for (const p of d.personas) {
      const key = slug(p.key);
      if (!key) continue;
      const old = g.personas.get(key);
      // Имя и важность уточняются, серия первого появления — нет
      g.personas.set(key, { ...p, key, first_ep: old?.first_ep ?? at(p.first_ep), revealed: old?.revealed ?? at(p.first_ep), title: old?.title ?? title });
      if (p.description_ru.trim()) g.notes.push({ key, from: Math.max(lo, at(p.first_ep)), upTo: hi, description_ru: p.description_ru.trim(), goal_ru: p.goal_ru.trim(), title });
    }
    const has = (k: string) => g.personas.has(slug(k));
    const once = <T,>(list: T[], item: T, same: (x: T) => boolean) => { if (!list.some(same)) list.push(item); };
    for (const a of d.aliases) if (a.alias && a.kind && has(a.key) && a.alias.trim())
      once(g.aliases, { ...a, key: slug(a.key), alias: a.alias.trim(), revealed: at(a.ep), title }, (x) => x.key === slug(a.key) && norm(x.alias) === norm(a.alias));
    for (const l of d.looks) if (l.kind && l.label_ru !== undefined && has(l.key))
      once(g.looks, { ...l, key: slug(l.key), look: slug(l.look || l.label_en || l.label_ru), revealed: at(l.ep), title }, (x) => x.key === slug(l.key) && x.look === slug(l.look || l.label_en || l.label_ru));
    for (const i of d.identities) if (has(i.a) && has(i.b) && slug(i.a) !== slug(i.b))
      once(g.identities, { ...i, a: slug(i.a), b: slug(i.b), revealed: at(i.ep), title }, (x) => [x.a, x.b].sort().join() === [slug(i.a), slug(i.b)].sort().join());
    for (const m of d.members) if (has(m.key) && has(m.group)) {
      const old = g.members.find((x) => x.title === title && x.key === slug(m.key) && x.group === slug(m.group) && !x.to_ep);
      if (old) { if (m.to_ep) old.to_ep = at(m.to_ep); continue; }
      g.members.push({ ...m, key: slug(m.key), group: slug(m.group), from_ep: at(m.from_ep), to_ep: m.to_ep ? at(m.to_ep) : 0, revealed: at(m.from_ep), title });
    }
    for (const r of d.relations) if (r.kind && has(r.a) && has(r.b) && slug(r.a) !== slug(r.b)) {
      const pair = (x: GRelation & At) => x.title === title && x.kind === r.kind && [x.a, x.b].sort().join() === [slug(r.a), slug(r.b)].sort().join() && !x.ended_ep;
      const old = g.relations.find(pair);
      // Отношение кончилось — у прежней записи появляется серия конца; новое отношение — новая запись
      if (old) { if (r.ended_ep) old.ended_ep = at(r.ended_ep); if (r.label_ru.trim()) old.label_ru = r.label_ru.trim(); continue; }
      g.relations.push({ ...r, a: slug(r.a), b: slug(r.b), from_ep: at(r.from_ep), ended_ep: r.ended_ep ? at(r.ended_ep) : 0, revealed: at(r.from_ep), title });
    }
    for (const e of d.events) {
      const key = slug(e.key || e.title_ru);
      if (!key || g.events.has(key)) continue;
      const participants = e.participants.filter((p) => has(p.key)).map((p) => ({ ...p, key: slug(p.key) }));
      const from = at(e.ep_from);
      g.events.set(key, { ...e, kind: e.kind ?? "другое", key, participants, ep_from: from, ep_to: Math.max(from, at(e.ep_to || e.ep_from)), revealed: Math.max(from, at(e.ep_to || e.ep_from)), title });
    }
    // Старые ответы в журнале бывают с дырами (поле не прошло проверку) — такие записи пропускаем
    for (const l of d.links) if (l.kind && g.events.has(slug(l.from)) && g.events.has(slug(l.to)) && slug(l.from) !== slug(l.to))
      once(g.links, { ...l, from: slug(l.from), to: slug(l.to), revealed: hi, title }, (x) => x.from === slug(l.from) && x.to === slug(l.to));
    for (const a of d.abilities) if (a.status && a.name_ru && has(a.key) && a.name_ru.trim()) {
      const old = g.abilities.findLast((x) => x.title === title && x.key === slug(a.key) && norm(x.name_ru) === norm(a.name_ru));
      // Статус способности меняется со временем — новая запись со своей серией, прежняя остаётся для ранних курсоров
      if (old?.status === a.status) continue;
      g.abilities.push({ ...a, key: slug(a.key), name_ru: a.name_ru.trim(), revealed: at(a.ep), title });
    }
    if (d.group_word_ru.trim()) g.groupWord = d.group_word_ru.trim();
    g.powerSystem ||= d.power_system;
  }
  return g;
}

/** Состояние графа для следующей порции — коротко: ключи, имена, кто есть кто, текущие связи и недавние события. */
export function graphForPrompt(g: Graph, recentEvents = 40): string {
  const note = new Map<string, GNote>();
  for (const n of g.notes) note.set(n.key, n);
  const lines: string[] = [];
  lines.push(`Группы в тайтле: ${g.groupWord || "нет"}; система сил: ${g.powerSystem ? "да" : "нет"}`);
  lines.push("Персонажи и группы (ключ | вид | важность | имя рус / англ | кто это):");
  for (const p of g.personas.values()) {
    lines.push(`${p.key} | ${p.kind} | ${p.importance} | ${p.name_ru} / ${p.name_en} | ${note.get(p.key)?.description_ru ?? ""}`);
  }
  if (g.aliases.length) lines.push(`Имена и облики: ${g.aliases.map((a) => `${a.key}: ${a.alias} (${a.kind})`).join("; ")}`);
  if (g.looks.length) lines.push(`Облики: ${g.looks.map((l) => `${l.key}/${l.look}: ${l.label_ru}`).join("; ")}`);
  if (g.identities.length) lines.push(`Раскрыто, что это одно лицо: ${g.identities.map((i) => `${i.a} = ${i.b}`).join("; ")}`);
  const members = g.members.filter((m) => !m.to_ep);
  if (members.length) lines.push(`Состоят в группах: ${members.map((m) => `${m.key} → ${m.group}${m.role_ru ? ` (${m.role_ru})` : ""}`).join("; ")}`);
  const rels = g.relations.filter((r) => !r.ended_ep);
  if (rels.length) lines.push(`Действующие отношения: ${rels.map((r) => `${r.a} — ${r.b}: ${r.kind}${r.label_ru ? ` (${r.label_ru})` : ""}`).join("; ")}`);
  const events = [...g.events.values()].sort((a, b) => b.ep_to - a.ep_to);
  const shown = [...events.filter((e) => e.major), ...events.filter((e) => !e.major)].slice(0, recentEvents).sort((a, b) => a.ep_from - b.ep_from);
  if (shown.length) lines.push(`События (ключ | серии | название):\n${shown.map((e) => `${e.key} | ${e.ep_from}${e.ep_to !== e.ep_from ? `–${e.ep_to}` : ""} | ${e.title_ru}`).join("\n")}`);
  if (g.abilities.length) lines.push(`Способности: ${g.abilities.map((a) => `${a.key}: ${a.name_ru} (${a.status})`).join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- имена

const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[・·=＝\-‐]/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean).sort().join(" ");

/** Одно ли это имя: тот же набор слов в любом порядке (японское — без пробелов и точек). */
export function sameName(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  const ka = nameKey(a), kb = nameKey(b);
  return ka === kb || ka.replace(/\s/g, "") === kb.replace(/\s/g, "");
}

/**
 * Связи «это один человек», раскрытые к серии at: группы сущностей (по id), в каждой — все склеенные.
 * Склейка транзитивна: А = Б и Б = В — одна группа.
 */
export function identityGroups<T extends number | string>(links: { a: T; b: T; revealed: number }[], at: number): Map<T, T[]> {
  const parent = new Map<T, T>();
  const find = (x: T): T => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const l of links) if (l.revealed <= at) parent.set(find(l.a), find(l.b));
  const groups = new Map<T, T[]>();
  for (const x of parent.keys()) { const r = find(x); groups.set(r, [...(groups.get(r) ?? [r]), ...(x === r ? [] : [x])]); }
  const out = new Map<T, T[]>();
  for (const members of groups.values()) { const all = [...new Set(members)]; for (const m of all) out.set(m, all); }
  return out;
}

export type Look = { image: string | null; label: string; kind: string; from: number };

const plain = (s: string) => s.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Облик, к которому привязано имя: явная привязка из разбора, иначе подпись облика совпадает с именем
 * («Сатору Миками» → облик «Сатору Миками (прошлая жизнь)», «слизень» → «Слизень»). Нет такого — null: имя общее.
 */
export function aliasLook(alias: string, explicit: string | null, looks: { look: string; label: string; label_en?: string | null }[]): string | null {
  if (explicit && looks.some((l) => l.look === explicit)) return explicit;
  const a = plain(alias);
  if (a.length < 3) return null;
  return looks.find((l) => { const b = plain(l.label); return b === a || (b.length >= 4 && a.length >= 4 && (b.startsWith(`${a} `) || a.startsWith(`${b} `))); })?.look ?? null;
}

/** Облик на серию at: последний показанный к этой серии (с картинкой); раньше всех — ничего. */
export function lookAt<L extends Look>(looks: L[], at: number): L | null {
  return looks.filter((l) => l.image && l.from <= at).sort((a, b) => a.from - b.from).at(-1) ?? null;
}

// ---------------------------------------------------------------- разметка имён в тексте

export type NameRef = { alias: string; entity: number };
export type TextPart = string | { text: string; entity: number; alias: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CONSONANT = /[бвгджзйклмнпрстфхцчшщ]/;

/** Имя, которое стоит размечать: собственное (с большой буквы), а не «слизень», «дракон бури», «уникальный». */
export const isProperName = (alias: string) => /^\p{Lu}/u.test(alias.trim());

/**
 * Буквы имени → нестрогий шаблон: одно японское имя модели пишут по-разному (Сидзуэ / Шизуэ, Идзава / Изава,
 * Клэйман / Клейман, Карион / Каррион) — си/ши, ти/чи, дзи/зи/джи, дз/з, е/э/ё, удвоенные согласные.
 */
function fuzzy(stem: string): string {
  const s = stem.toLowerCase();
  let out = "";
  for (let i = 0; i < s.length; ) {
    const rest = s.slice(i);
    const m = rest.match(/^(?:дзи|джи|зи)/) ?? rest.match(/^(?:ши|си)/) ?? rest.match(/^(?:чи|ти)/) ?? rest.match(/^д?з/);
    if (m) {
      out += /и$/.test(m[0]) ? (m[0].startsWith("ш") || m[0].startsWith("с") ? "(?:ши|си)" : m[0].startsWith("ч") || m[0].startsWith("т") ? "(?:чи|ти)" : "(?:д?зи|джи)") : "д?з";
      i += m[0].length;
      continue;
    }
    const c = s[i];
    if ("еэё".includes(c)) out += "[еэё]";
    else if (CONSONANT.test(c)) {
      out += `${c}+`;
      while (s[i + 1] === c) i++;
    } else out += escapeRe(c);
    i++;
  }
  return out;
}

/** Слово имени с русскими окончаниями: «Вельдора» ловит «Вельдоры», «Вельдорой»; несклоняемые («Римуру») — как есть. */
function wordPattern(w: string): string {
  if (!/^[а-яё]/i.test(w)) return escapeRe(w);
  // На гласную, кроме «а/я», японские имена не склоняются
  if (w.length < 4 || /[уюоеиэы]$/i.test(w)) return fuzzy(w);
  if (/[аяйь]$/i.test(w)) return `${fuzzy(w.slice(0, -1))}[а-яё]{1,3}`;
  return `${fuzzy(w)}[а-яё]{0,3}`;
}

/**
 * Текст → куски с именами персонажей (для карточки при наведении). Длинные имена — раньше коротких:
 * «Сатору Миками» не разбивается на «Сатору». Одно имя у двух персонажей — не размечается (неясно, кто).
 * Ссылка — только на первое упоминание персонажа в абзаце; два его имени подряд («дриада Трейни») — одна ссылка.
 * Слово внутри составного названия через дефис («Джура-Темпест») — не имя.
 */
export function linkNames(text: string, refs: NameRef[]): TextPart[] {
  const byAlias = new Map<string, Set<number>>();
  const proper = new Set<string>();
  for (const r of refs) {
    const k = norm(r.alias);
    if (k.length < 2) continue;
    byAlias.set(k, (byAlias.get(k) ?? new Set()).add(r.entity));
    if (isProperName(r.alias)) proper.add(k);
  }
  const usable = [...byAlias.entries()].filter(([, s]) => s.size === 1).map(([alias, s]) => ({ alias, entity: [...s][0], proper: proper.has(alias) }))
    .sort((a, b) => b.alias.length - a.alias.length);
  if (!usable.length) return [text];
  const pats = usable.map((u) => `(${u.alias.split(" ").map(wordPattern).join("\\s+")})`);
  const re = new RegExp(`(?<![\\p{L}-])(?:${pats.join("|")})(?![\\p{L}-])`, "giu");
  const out: TextPart[] = [];
  const push = (s: string) => { if (s) out.push(s); };
  let last = 0;
  let seen = new Set<number>();
  for (const m of text.matchAll(re)) {
    const i = m.slice(1).findIndex((x) => x !== undefined);
    if (i < 0) continue;
    const gap = text.slice(last, m.index);
    // Новый абзац — заново ссылки на первое упоминание
    if (/\n\s*\n/.test(gap)) seen = new Set();
    const { entity, alias } = usable[i];
    // Имя пишется с большой буквы: «официантка» в тексте — не персонаж «Официантка»
    if (usable[i].proper && !/^\p{Lu}/u.test(m[0])) continue;
    const prev = out.at(-1);
    if (prev && typeof prev !== "string" && prev.entity === entity && /^\s+$/.test(gap)) {
      prev.text += gap + m[0];
    } else if (seen.has(entity)) {
      push(gap + m[0]);
    } else {
      push(gap);
      out.push({ text: m[0], entity, alias });
      seen.add(entity);
    }
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  // Соседние обычные куски — в один
  return out.reduce<TextPart[]>((a, p) => (typeof p === "string" && typeof a.at(-1) === "string" ? [...a.slice(0, -1), (a.at(-1) as string) + p] : [...a, p]), []);
}
