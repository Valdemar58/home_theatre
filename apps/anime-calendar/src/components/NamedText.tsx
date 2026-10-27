"use client";
import Link from "next/link";
import { Fragment, useMemo } from "react";
import { useNameRefs } from "@/lib/client";
import { linkNames } from "@/lib/plot-graph";
import type { CastMember, NameCard, NameRef, NameRefs } from "@/lib/types";
import { useCharacterHover } from "./HoverCard";

// Имена персонажей в тексте о сюжете → ссылки с карточкой при наведении. Текст о серии upTo знает только имена,
// раскрытые к ней, и показывает персонажа таким, каким он был тогда: облик той серии, «он же» — только если уже раскрыто.
// Персонаж, которого зритель ещё не видел (режим «весь сезон», текст о будущей серии), — размытая карточка.

/** Имена тайтла для текстов о сериях до maxEp (один запрос на страницу) вместе с карточками на курсор. */
export function useNames(anilistId: number, maxEp: number | null): NameRefs | undefined {
  return useNameRefs(anilistId, maxEp).data;
}

/** Абзацы пересказа сезона идут по аркам: абзац i — о сериях арки i (конец арки). Не совпало число — не знаем. */
export function paragraphEps(arcs: { eps: string }[], text: string): number[] | undefined {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length !== arcs.length) return undefined;
  return arcs.map((a) => Number(a.eps.match(/\d+/g)?.at(-1) ?? 0) || Infinity);
}

/** Персонаж из текста о серии at: облик на эту серию, склейка — только раскрытая к ней. */
function cardMember(card: NameCard, entity: number, at: number): CastMember {
  const img = card.images.filter((i) => i.ep <= at).at(-1) ?? null;
  return {
    id: entity, entities: [entity], href: card.href, anilistCharId: null, name: card.name, native: card.native, role: card.role,
    image: img?.url ?? null, lookLabel: img?.label ?? null, description: card.description, goal: card.goal, groups: card.groups,
    aka: card.mergedInto && card.mergedInto.ep <= at ? [card.mergedInto.name] : [], firstEp: card.firstEp, voice: null,
  };
}

export function NamedText({ text, anilistId, upTo, names, byParagraph }: {
  text: string;
  anilistId: number;
  /** Текст о сериях до этой (своего тайтла); null — без ограничения */
  upTo: number | null;
  names: NameRefs | undefined;
  /** Серия каждого абзаца (пересказ сезона по аркам) — точнее, чем upTo всего текста */
  byParagraph?: number[];
}) {
  if (!names) return <>{text}</>;
  if (byParagraph) {
    const parts = text.split(/(\n\s*\n)/);
    let i = 0;
    return <>{parts.map((p, k) => (/^\n\s*\n$/.test(p) || !p.trim() ? <Fragment key={k}>{p}</Fragment>
      : <Paragraph key={k} text={p} anilistId={anilistId} upTo={Math.min(byParagraph[i++] ?? Infinity, upTo ?? Infinity)} names={names} />))}</>;
  }
  return <Paragraph text={text} anilistId={anilistId} upTo={upTo ?? Infinity} names={names} />;
}

function Paragraph({ text, anilistId, upTo, names }: { text: string; anilistId: number; upTo: number; names: NameRefs }) {
  const parts = useMemo(() => {
    const refs = names.refs.filter((r) => r.anilistId !== anilistId || r.revealedEp <= upTo);
    // Ссылка — по найденному имени: «Сатору Миками» и «Римуру» — один персонаж, но разные облики в карточке
    const key = (alias: string, entity: number) => `${entity}:${alias.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()}`;
    const byAlias = new Map(refs.map((r) => [key(r.alias, r.entity), r]));
    return linkNames(text, refs.map((r) => ({ alias: r.alias, entity: r.entity }))).map((p) => (typeof p === "string" ? p : { ...p, ref: byAlias.get(key(p.alias, p.entity))! }));
  }, [text, names.refs, upTo, anilistId]);
  const at = Math.min(upTo, names.cursor);
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? p : (
        <NameLink key={i} text={p.text} anilistId={anilistId} ref_={p.ref} member={names.cards[p.entity] ? cardMember(names.cards[p.entity], p.entity, at) : null} />
      ))}
    </>
  );
}

function NameLink({ text, anilistId, ref_, member }: { text: string; anilistId: number; ref_: NameRef; member: CastMember | null }) {
  const spoiler = ref_.spoiler || !member;
  const hover = useCharacterHover({ anilistId: ref_.anilistId ?? anilistId, entity: ref_.entity, member: spoiler ? null : member, spoilerEp: spoiler ? ref_.revealedEp : null, as: ref_.as });
  return (
    <Link {...hover} href={spoiler ? "#" : ref_.href} onClick={(e) => { hover.onClick?.(e); if (spoiler) e.preventDefault(); }}
      className="text-accent-200 underline decoration-accent-400/70 decoration-dashed underline-offset-4 hover:decoration-solid">
      {text}
    </Link>
  );
}
