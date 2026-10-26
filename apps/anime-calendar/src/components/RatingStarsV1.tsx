"use client";
// Вариант 1 звёзд оценки (сохранён по просьбе пользователя, чтобы можно было вернуться): гранёные
// оранжево-золотые звёзды, разбитая серая для 1–3, лучи и сияние у 10.
import { useId, useState } from "react";
import { cx } from "./ui";

// Оценка 1–10 звёздами. Все звёзды — обычные, и только звезда под курсором (или выбранная)
// принимает форму своей оценки: 1–3 — разбитая, 4–5 — чеканная, 6–7 — гранёная,
// 8 — гранёная с бликом, 9 — с мерцающими искрами, 10 — сияющая с лучами.

const CX = 10;
const CY = 10.6;

/** Вершины звезды: чётные — внешние, нечётные — внутренние. */
function points(R = 8.4, r = 3.8): [number, number][] {
  return Array.from({ length: 10 }, (_, k) => {
    const a = ((-90 + k * 36) * Math.PI) / 180;
    const rad = k % 2 ? r : R;
    return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
  });
}
const fmt = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
const STAR = fmt(points());

const GOLD = "#fbbf24";
const GOLD_DARK = "#d97706";
const GOLD_LIGHT = "#fde68a";
const EMPTY = "#4b5563";

/** Обычная звезда: залитая или пустая. */
function Plain({ filled }: { filled: boolean }) {
  return <polygon points={STAR} fill={filled ? GOLD : EMPTY} stroke={filled ? GOLD : EMPTY} strokeWidth={1.4} strokeLinejoin="round" />;
}

/** Грани: светлые и тёмные треугольники от центра к вершинам. */
function Facets() {
  const pts = points();
  return (
    <>
      <polygon points={STAR} fill={GOLD_DARK} stroke={GOLD_DARK} strokeWidth={1.4} strokeLinejoin="round" />
      {pts.map((p, k) => (
        <polygon key={k} points={fmt([[CX, CY], p, pts[(k + 1) % 10]])} fill={k % 2 ? GOLD_DARK : GOLD} />
      ))}
    </>
  );
}

function Sparkle({ x, y, s, begin }: { x: number; y: number; s: number; begin: string }) {
  return (
    <path d={`M${x} ${y - s}L${x + s * 0.22} ${y - s * 0.22}L${x + s} ${y}L${x + s * 0.22} ${y + s * 0.22}L${x} ${y + s}L${x - s * 0.22} ${y + s * 0.22}L${x - s} ${y}L${x - s * 0.22} ${y - s * 0.22}Z`}
      fill={GOLD_LIGHT} opacity={0}>
      <animate attributeName="opacity" values="0;1;0;0" keyTimes="0;0.2;0.45;1" dur="2.2s" begin={begin} repeatCount="indefinite" />
    </path>
  );
}

/** Звезда в форме своей оценки. */
function Special({ score }: { score: number }) {
  const uid = useId().replace(/:/g, "");
  const clip = `star${uid}`;

  // 1–3: звезда разломлена пополам, тусклая
  if (score <= 3) {
    const crack = "10.4,0 9.2,6 11,9.6 8.8,13.2 10.2,20";
    return (
      <>
        <defs>
          <clipPath id={`l${uid}`}><polygon points={`0,0 ${crack} 0,20`} /></clipPath>
          <clipPath id={`r${uid}`}><polygon points={`20,0 ${crack} 20,20`} /></clipPath>
        </defs>
        <g clipPath={`url(#l${uid})`} transform="rotate(-8 9 18) translate(-0.6 0)">
          <polygon points={STAR} fill="#6b7280" stroke="#6b7280" strokeWidth={1.4} strokeLinejoin="round" />
        </g>
        <g clipPath={`url(#r${uid})`} transform="rotate(9 11 18) translate(0.6 0.3)">
          <polygon points={STAR} fill="#6b7280" stroke="#6b7280" strokeWidth={1.4} strokeLinejoin="round" />
        </g>
      </>
    );
  }

  // 4–5: чеканная — звезда с выпуклой серединкой
  if (score <= 5) {
    return (
      <>
        <polygon points={STAR} fill={GOLD_DARK} stroke={GOLD_DARK} strokeWidth={1.4} strokeLinejoin="round" />
        <polygon points={fmt(points(5.4, 2.4))} fill={GOLD} strokeLinejoin="round" />
      </>
    );
  }

  // 6–7: гранёная
  if (score <= 7) return <Facets />;

  return (
    <>
      <defs>
        <clipPath id={clip}><polygon points={STAR} /></clipPath>
        <radialGradient id={`glow${uid}`}>
          <stop offset="0%" stopColor={GOLD} stopOpacity={0.7} />
          <stop offset="100%" stopColor={GOLD} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* 10: сияние и медленно вращающиеся лучи */}
      {score === 10 && (
        <>
          <circle cx={CX} cy={CY} r={11} fill={`url(#glow${uid})`}>
            <animate attributeName="r" values="9;12.5;9" dur="2s" repeatCount="indefinite" />
          </circle>
          <g stroke={GOLD_LIGHT} strokeWidth={1.1} strokeLinecap="round">
            {Array.from({ length: 8 }, (_, k) => {
              const a = ((k * 45 + 22.5) * Math.PI) / 180;
              return <line key={k} x1={CX + 10 * Math.cos(a)} y1={CY + 10 * Math.sin(a)} x2={CX + 12.5 * Math.cos(a)} y2={CY + 12.5 * Math.sin(a)} />;
            })}
            <animateTransform attributeName="transform" type="rotate" from={`0 ${CX} ${CY}`} to={`360 ${CX} ${CY}`} dur="12s" repeatCount="indefinite" />
          </g>
        </>
      )}

      <Facets />

      {/* 8–10: блик пробегает по звезде */}
      <g clipPath={`url(#${clip})`}>
        <rect x={-6} y={-4} width={4} height={30} fill="#fff" opacity={0.55} transform="rotate(25 10 10)">
          <animate attributeName="x" values="-6;-6;24" keyTimes="0;0.55;1" dur={score === 8 ? "3s" : "2.4s"} repeatCount="indefinite" />
        </rect>
      </g>

      {/* 9–10: мерцающие искры */}
      {score >= 9 && (
        <>
          <Sparkle x={17.5} y={2.5} s={2.2} begin="0s" />
          <Sparkle x={2.5} y={4} s={1.6} begin="0.7s" />
          {score === 10 && <Sparkle x={17} y={18} s={1.8} begin="1.4s" />}
        </>
      )}
    </>
  );
}

/** Одна звезда ряда: в форме оценки (special) или обычная. */
export function ScoreStarV1({ score, special, filled, size = 24 }: { score: number; special: boolean; filled: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} overflow="visible" aria-hidden>
      {special ? <Special score={score} /> : <Plain filled={filled} />}
    </svg>
  );
}

/** Ряд из 10 звёзд: наведённая (или выбранная) звезда — в форме своей оценки. */
export function RatingStarsV1({ value, onChange, size = 24 }: { value: number; onChange: (n: number) => void; size?: number }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="flex" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button key={n} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)}
          onClick={() => onChange(n === value ? 0 : n)} aria-label={`Оценка ${n}`}
          className={cx("p-0.5 transition-transform", n === shown && "scale-110")}>
          <ScoreStarV1 score={n} special={n === shown} filled={n <= shown} size={size} />
        </button>
      ))}
    </div>
  );
}
