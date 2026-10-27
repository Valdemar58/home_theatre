"use client";
import { UserIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useState } from "react";
import { useTitleCast } from "@/lib/client";
import type { CastMember } from "@/lib/types";
import type { CharacterHoverData } from "./HoverCard";
import { Img } from "./Img";
import { Badge } from "./ui";

// Карточка персонажа во всплывающем окне (наведение на имя в тексте или на карточку в составе тайтла).
// Персонаж, которого зритель ещё не видел, — размыт целиком: портрет, имя, описание; открыть — по кнопке.

export const ROLE_LABEL = { MAIN: "главный", SUPPORTING: "второй план", BACKGROUND: "эпизод" } as const;

export function CharacterHoverBody({ data, onNavigate }: { data: CharacterHoverData; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const all = useTitleCast(open ? data.anilistId : 0, "all");
  if (data.member) return <MemberCard m={data.as ? asLook(data.member, data.as) : data.member} onNavigate={onNavigate} />;
  if (open) {
    const m = all.data?.members.find((x) => x.id === data.entity || x.entities.includes(data.entity));
    if (all.isLoading) return <div className="h-36 animate-pulse rounded-lg bg-gray-700/40" />;
    return m ? <MemberCard m={data.as ? asLook(m, data.as) : m} onNavigate={onNavigate} spoiler /> : <p className="text-sm text-gray-400">О персонаже пока ничего нет.</p>;
  }
  return (
    <div className="relative">
      <div className="flex gap-3 blur-md select-none" aria-hidden>
        <span className="h-32 w-22 shrink-0 rounded-lg bg-special-500/30" />
        <span className="flex flex-1 flex-col gap-2 pt-1">
          <span className="h-4 w-28 rounded bg-gray-500" />
          <span className="h-3 w-40 rounded bg-gray-600" />
          <span className="h-3 w-32 rounded bg-gray-600" />
        </span>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
        <span className="text-sm text-special-200">{data.spoilerEp ? `Появится в ${data.spoilerEp} серии` : "Вы ещё не видели этого персонажа"}</span>
        <button onClick={() => setOpen(true)} className="rounded-lg px-3 py-1.5 text-sm tone-special soft">Показать спойлер</button>
      </div>
    </div>
  );
}

/**
 * Персонаж под именем из текста: «Сатору Миками» — его облик (прошлая жизнь), а не нынешний слизень;
 * нынешнее имя — в «он же», описание нынешнего облика не показываем.
 */
function asLook(m: CastMember, as: NonNullable<CharacterHoverData["as"]>): CastMember {
  return { ...m, name: as.name, image: as.image, lookLabel: as.lookLabel, aka: [m.name, ...m.aka.filter((a) => a !== as.name)], description: null, goal: null, native: null };
}

function MemberCard({ m, onNavigate, spoiler }: { m: CastMember; onNavigate: () => void; spoiler?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <Link href={m.href} onClick={onNavigate} className="relative aspect-2/3 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700">
          {m.image ? <Img src={m.image} size="thumb" lazy={false} className="absolute inset-0 h-full w-full object-cover object-top" />
            : <span className="flex h-full items-center justify-center text-gray-600"><UserIcon className="h-8 w-8" /></span>}
        </Link>
        <div className="min-w-0 flex-1 space-y-1">
          <Link href={m.href} onClick={onNavigate} className="block text-base font-semibold leading-snug hover:text-accent-300">{m.name}</Link>
          {(m.native || m.aka.length > 0) && <p className="text-xs text-gray-400">{[m.native, ...m.aka.map((a) => `он же ${a}`)].filter(Boolean).join(" · ")}</p>}
          {m.description && <p className="line-clamp-5 text-sm leading-relaxed text-gray-300">{m.description}</p>}
        </div>
      </div>
      {(m.groups.length > 0 || m.goal) && (
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs">
          {m.groups.length > 0 && <><dt className="text-gray-500">Группа</dt><dd className="text-gray-300">{m.groups.map((g) => g.role ? `${g.name} · ${g.role}` : g.name).join(", ")}</dd></>}
          {m.goal && <><dt className="text-gray-500">Цель</dt><dd className="text-gray-300">{m.goal}</dd></>}
        </dl>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="neutral">{ROLE_LABEL[m.role]}</Badge>
        {m.lookLabel && <Badge tone="accent">облик: {m.lookLabel}</Badge>}
        {m.firstEp && <Badge tone="neutral">впервые · с. {m.firstEp}</Badge>}
        {spoiler && <Badge tone="special">спойлер</Badge>}
      </div>
    </div>
  );
}
