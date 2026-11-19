"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useAnime, useList, useMatch } from "@/lib/client";
import { FORMAT_LABELS, GENRE_LABELS, SEASON_LABELS, STATUS_LABELS, label } from "@/lib/labels";
import { displayTitle } from "@/lib/schedule";
import { pluralEpisodes } from "@/lib/time";
import type { CastMember, MediaLite, NameRef } from "@/lib/types";
import { CharacterHoverBody } from "./CharacterHover";
import { Img } from "./Img";
import { ListControl } from "./ListControl";
import { NextEpisode } from "./NextEpisode";
import { RequestButton } from "./RequestButton";
import { Scores } from "./Scores";
import { VoicesButton } from "./VoicesButton";
import { Badge, TONE_CLASS, cx, matchTone, modalsOpen } from "./ui";

// Всплывающая карточка тайтла при наведении — одна на всё приложение (календарь, каталог, «Похожее»,
// «Для тебя», списки): полное название, альтернативные, жанры, синопсис, прогноз и быстрые действия.
// Только для устройств с мышью; на телефоне тап ведёт на страницу тайтла.

/** Дополнительные секции для конкретного места (например, похожесть в «Похожем»). */
/** reason — почему советуем (полный текст рекомендации в «Для тебя»). */
export type HoverExtra = { similarity?: { value: number; to: string }; reason?: string };

/** Карточка персонажа (имя в тексте, карточка в составе): данные на курсор зрителя или размытый спойлер */
export type CharacterHoverData = {
  anilistId: number; entity: number; member: CastMember | null; spoilerEp: number | null;
  /** Имя из текста привязано к особому облику — карточка под этим именем и с этим обликом */
  as?: NameRef["as"];
};

/** sheet — на телефоне: карточка шторкой снизу по тапу (наведения нет) */
type Shown = { id: number; media?: MediaLite; rect: DOMRect; extra?: HoverExtra; character?: CharacterHoverData; sheet?: boolean };
type Ctx = { show: (s: Shown) => void; hide: () => void; keep: () => void; close: () => void };

const HoverCtx = createContext<Ctx | null>(null);

const OPEN_DELAY = 400;
const CLOSE_DELAY = 200;
const WIDTH = 440;
const CHAR_WIDTH = 380;

const canHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Обработчики для элемента-якоря: навели — через 0.4 с карточка, ушли — закрыть (если не на неё). */
type AnchorHandlers = Partial<Pick<React.DOMAttributes<HTMLElement>, "onPointerEnter" | "onPointerLeave" | "onClick">>;

export function useHoverCard(media: MediaLite | number, extra?: HoverExtra): AnchorHandlers {
  return useAnchor(() => (typeof media === "number" ? { id: media, extra } : { id: media.id, media, extra }));
}

/**
 * Карточка персонажа при наведении — та же механика, что у тайтла (задержка, закрытие, позиция).
 * tapSheet — имя в тексте: на телефоне тап открывает карточку шторкой снизу, а не страницу (там и спойлер не открыть).
 */
export function useCharacterHover(character: CharacterHoverData, opts?: { tapSheet?: boolean }): AnchorHandlers {
  return useAnchor(() => ({ id: -character.entity, character }), opts?.tapSheet);
}

function useAnchor(make: () => Omit<Shown, "rect">, tapSheet = false): AnchorHandlers {
  const ctx = useContext(HoverCtx);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!ctx) return {};
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse" || !canHover()) return;
      const el = e.currentTarget;
      if (timer.current) clearTimeout(timer.current);
      const s = make();
      timer.current = setTimeout(() => ctx.show({ ...s, rect: el.getBoundingClientRect() }), OPEN_DELAY);
    },
    onPointerLeave: () => {
      if (timer.current) clearTimeout(timer.current);
      ctx.hide();
    },
    // Клик по карточке-якорю — переход: всплывающая не нужна (и не должна открыться по таймеру уже на новой странице)
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (timer.current) clearTimeout(timer.current);
      if (tapSheet && !canHover()) {
        e.preventDefault();
        ctx.show({ ...make(), rect: e.currentTarget.getBoundingClientRect(), sheet: true });
        return;
      }
      ctx.close();
    },
  };
}

export function HoverCardHost({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useCallback(() => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const hide = useCallback(() => {
    keep();
    // Из карточки открыто окно (озвучки, запрос) — не закрываем, иначе закроется и окно
    closeTimer.current = setTimeout(() => { if (!modalsOpen()) setShown(null); }, CLOSE_DELAY);
  }, [keep]);
  const show = useCallback((s: Shown) => { keep(); setShown(s); }, [keep]);
  const close = useCallback(() => { keep(); setShown(null); }, [keep]);
  const floating = useRef<HTMLDivElement>(null);
  // Переход на другую страницу (ссылки Next.js не вызывают popstate) — закрыть
  const pathname = usePathname();
  useEffect(() => close(), [pathname, close]);

  // Прокрутка и переход на другую страницу — закрыть
  useEffect(() => {
    if (!shown) return;
    // Прокрутка внутри самой карточки (развёрнутый синопсис) — не повод закрывать
    const close = (e: Event) => {
      if (e.target instanceof Node && floating.current?.contains(e.target)) return;
      if (!modalsOpen()) setShown(null);
    };
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("popstate", close);
    return () => { window.removeEventListener("scroll", close, { capture: true }); window.removeEventListener("popstate", close); };
  }, [shown]);

  return (
    <HoverCtx.Provider value={{ show, hide, keep, close }}>
      {children}
      {shown && createPortal(shown.sheet && shown.character
        ? <Sheet key={shown.id} ref={floating} character={shown.character} onClose={() => setShown(null)} />
        : <Floating key={shown.id} ref={floating} shown={shown} onEnter={keep} onLeave={hide} onClose={() => setShown(null)} />, document.body)}
    </HoverCtx.Provider>
  );
}

function Floating({ ref, shown, onEnter, onLeave, onClose }: {
  ref: React.RefObject<HTMLDivElement | null>; shown: Shown; onEnter: () => void; onLeave: () => void; onClose: () => void;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { rect } = shown;
  const width = shown.character ? CHAR_WIDTH : WIDTH;

  // Справа от якоря, если влезает, иначе слева; по вертикали — не вылезая за окно
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 400;
    const gap = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Имя в строке текста — карточка под ним (сбоку от слова мешает читать), постер — справа или слева
    const inline = Boolean(shown.character) && rect.height < 40;
    const left = inline ? Math.min(Math.max(8, rect.left), vw - width - 8)
      : rect.right + gap + width <= vw - 8 ? rect.right + gap : Math.max(8, rect.left - gap - width);
    const below = rect.bottom + 6 + h <= vh - 8;
    const top = inline ? (below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - h)) : Math.min(Math.max(8, rect.top), Math.max(8, vh - h - 8));
    setPos({ left, top });
  }, [rect, width, shown.character, ref]);

  return (
    <div ref={ref} onPointerEnter={onEnter} onPointerLeave={onLeave}
      className="fixed z-50 rounded-xl bg-gray-800/97 p-4 shadow-2xl ring-1 ring-gray-600 backdrop-blur"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {shown.character
        ? <CharacterHoverBody data={shown.character} onNavigate={onClose} />
        : <HoverBody id={shown.id} media={shown.media} extra={shown.extra} onNavigate={onClose} />}
    </div>
  );
}

/** Шторка снизу (телефон): карточка персонажа и «Открыть страницу»; закрывается тапом мимо, свайпом вниз, Esc. */
function Sheet({ ref, character, onClose }: { ref: React.RefObject<HTMLDivElement | null>; character: CharacterHoverData; onClose: () => void }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const href = character.member?.href;
  return (
    <div className="fixed inset-0 z-50">
      <button aria-label="Закрыть" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div ref={ref} role="dialog" aria-modal
        className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto overscroll-contain rounded-t-2xl bg-gray-800 px-4 pt-2 shadow-2xl ring-1 ring-gray-600 pb-[max(1rem,env(safe-area-inset-bottom))]"
        style={{ transform: drag ? `translateY(${drag}px)` : undefined }}
        // Свайп вниз от верха шторки — закрыть
        onTouchStart={(e) => { start.current = e.currentTarget.scrollTop <= 0 ? e.touches[0].clientY : null; }}
        onTouchMove={(e) => { if (start.current !== null) setDrag(Math.max(0, e.touches[0].clientY - start.current)); }}
        onTouchEnd={() => { if (drag > 80) onClose(); else setDrag(0); start.current = null; }}>
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-600" />
        <CharacterHoverBody data={character} onNavigate={onClose} />
        {href && <Link href={href} onClick={onClose} className="mt-4 block rounded-lg px-3 py-2.5 text-center text-sm font-medium tone-accent soft">Открыть страницу</Link>}
      </div>
    </div>
  );
}

const cleanText = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

function HoverBody({ id, media, extra, onNavigate }: { id: number; media?: MediaLite; extra?: HoverExtra; onNavigate: () => void }) {
  const { data: details } = useAnime(id);
  const { byId } = useList();
  const entry = byId.get(id);
  const seen = entry && ["completed", "dropped", "rewatching"].includes(entry.status);
  const { data: match } = useMatch(id, !seen);
  const [full, setFull] = useState(false);
  const m = details ?? media;
  if (!m) return <div className="h-48 animate-pulse rounded-lg bg-gray-700/40" />;
  const alts = [m.title.english, m.title.romaji].filter((t, i, all): t is string => Boolean(t) && t !== displayTitle(m.title) && all.indexOf(t) === i);
  const synopsis = details?.description ? cleanText(details.description) : null;
  const season = m.season ? `${SEASON_LABELS[m.season]} ${m.seasonYear ?? ""}` : m.seasonYear;

  return (
    <div className="space-y-3">
      <div className="flex gap-4">
        <Link href={`/anime/${m.id}`} onClick={onNavigate} className="relative aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-lg ring-1 ring-gray-700"
          style={{ backgroundColor: m.coverImage.color ?? undefined }}>
          {m.coverImage.large && <Img src={m.coverImage.large} size="card" lazy={false} className="absolute inset-0 h-full w-full object-cover" />}
        </Link>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Link href={`/anime/${m.id}`} onClick={onNavigate} className="block text-base font-semibold leading-snug hover:text-indigo-300">
            {displayTitle(m.title)}
          </Link>
          {alts.map((t) => <p key={t} className="text-xs leading-snug text-gray-400">{t}</p>)}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-xs text-gray-300">
            <span>{label(FORMAT_LABELS, m.format)}</span>
            <span className="text-gray-500">·</span>
            <span>{label(STATUS_LABELS, m.status)}</span>
            {season && <><span className="text-gray-500">·</span><span>{season}</span></>}
            {m.episodes && <><span className="text-gray-500">·</span><span>{pluralEpisodes(m.episodes)}</span></>}
          </div>
          <Scores media={m} size="xs" />
          <NextEpisode media={m} variant="inline" />
        </div>
      </div>

      {m.genres.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {m.genres.map((g) => <Badge key={g} tone="accent">{GENRE_LABELS[g] ?? g}</Badge>)}
        </div>
      )}

      {(match || extra?.similarity) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {extra?.similarity && (
            <span className="rounded-full px-2.5 py-1 tone-info soft">
              ≈ {extra.similarity.value}% похоже на «{extra.similarity.to}»
            </span>
          )}
          {match && (
            <span className={cx("rounded-full px-2.5 py-1 soft", TONE_CLASS[matchTone(match.percent)])}>
              <b>{match.percent}%</b> · {match.verdict}
            </span>
          )}
        </div>
      )}

      {extra?.reason && (
        <div className="rounded-lg tone-accent soft px-3 py-2 text-sm leading-relaxed">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider opacity-70">Почему советуем</p>
          {extra.reason}
        </div>
      )}

      {synopsis ? (
        <div className="text-sm leading-relaxed text-gray-300">
          <p className={cx("whitespace-pre-line", full ? "max-h-64 overflow-y-auto overscroll-contain pr-1" : "line-clamp-5")}>{synopsis}</p>
          {synopsis.length > 320 && (
            <button onClick={() => setFull(!full)} className="mt-1 text-xs text-indigo-300 hover:text-indigo-200">
              {full ? "Свернуть" : "Показать полностью"}
            </button>
          )}
        </div>
      ) : !details ? (
        <div className="space-y-1.5"><div className="h-3 animate-pulse rounded bg-gray-700/60" /><div className="h-3 w-4/5 animate-pulse rounded bg-gray-700/60" /></div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-700/60 pt-3">
        <ListControl media={m} compact />
        <RequestButton media={m} size="sm" />
        <VoicesButton media={m} size="sm" />
      </div>
    </div>
  );
}

/** Обёртка-якорь для мест, где хук не подключить (элементы списков в map). */
export function HoverZone({ media, extra, className, children }: { media: MediaLite; extra?: HoverExtra; className?: string; children: React.ReactNode }) {
  const hover = useHoverCard(media, extra);
  return <div {...hover} className={className}>{children}</div>;
}
