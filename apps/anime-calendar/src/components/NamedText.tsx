"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useNameRefs, useTitleCast } from "@/lib/client";
import { linkNames } from "@/lib/plot-graph";
import type { CastMember, NameRef } from "@/lib/types";
import { useCharacterHover } from "./HoverCard";

// Имена персонажей в тексте о сюжете → ссылки с карточкой при наведении. Текст о серии upTo знает только имена,
// раскрытые к ней; персонаж, которого зритель ещё не видел (режим «весь сезон», текст о будущей серии), — размытая карточка.

/** Имена тайтла для текстов о сериях до maxEp (один запрос на страницу), карточки — из состава на курсор. */
export function useNames(anilistId: number, maxEp: number | null) {
  const refs = useNameRefs(anilistId, maxEp).data;
  const cast = useTitleCast(anilistId).data;
  return { refs, members: cast?.members };
}

export function NamedText({ text, anilistId, upTo, names }: {
  text: string;
  anilistId: number;
  /** Текст о сериях до этой (своего тайтла); null — без ограничения */
  upTo: number | null;
  names: ReturnType<typeof useNames>;
}) {
  const parts = useMemo(() => {
    const refs = (names.refs ?? []).filter((r) => upTo === null || r.anilistId !== anilistId || r.revealedEp <= upTo);
    // Ссылка — по найденному имени: «Сатору Миками» и «Римуру» — один персонаж, но разные облики в карточке
    const key = (alias: string, entity: number) => `${entity}:${alias.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()}`;
    return { parts: linkNames(text, refs.map((r) => ({ alias: r.alias, entity: r.entity }))), byAlias: new Map(refs.map((r) => [key(r.alias, r.entity), r])), key };
  }, [text, names.refs, upTo, anilistId]);
  if (!names.refs) return <>{text}</>;
  return (
    <>
      {parts.parts.map((p, i) => typeof p === "string" ? p : (
        <NameLink key={i} text={p.text} anilistId={anilistId} ref_={parts.byAlias.get(parts.key(p.alias, p.entity))!}
          member={names.members?.find((m) => m.id === p.entity || m.entities.includes(p.entity)) ?? null} />
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
