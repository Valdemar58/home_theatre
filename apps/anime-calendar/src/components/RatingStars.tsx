"use client";
import { useId, useState } from "react";
import { cx } from "./ui";

// Оценка 1–10 звёздами. Все звёзды — обычные, и только звезда под курсором (или выбранная)
// принимает форму своей оценки. Один цвет — золото; оценку передают яркость и тонкая
// гравировка (внутренний контур того же золота):
//   1–3 — разломленная, тусклая
//   4–5 — одна линия гравировки
//   6–7 — две линии
//   8   — две линии + мягкий блик
//   9   — гравировка светлеет, + две мерцающие искры
//   10  — светлая гравировка мерцает, тёплое сияние вокруг, + третья искра
// Прошлый вариант — RatingStarsV1.tsx.

const CX = 10;
const CY = 10.6;

function points(R = 8.4, r = 3.9): [number, number][] {
  return Array.from({ length: 10 }, (_, k) => {
    const a = ((-90 + k * 36) * Math.PI) / 180;
    const rad = k % 2 ? r : R;
    return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
  });
}
const fmt = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
const STAR = fmt(points());
const LINE1 = fmt(points(5.4, 2.45));
const LINE2 = fmt(points(2.9, 1.3));

// Золото: шампанское → янтарь; тусклое — то же золото, приглушённое
const GOLD = ["#fde7a6", "#f2b33d"] as const;
const DIM = ["#b9a77c", "#8d7340"] as const;
const ENGRAVE = "#c98a1e";
const ENGRAVE_LIGHT = "#fff6da";
const EMPTY = "#4b5563";

/** Звезда со скруглёнными углами (обводка того же цвета, что и заливка). */
const Shape = ({ fill, stroke = fill, points: pts = STAR, width = 1.6 }: { fill: string; stroke?: string; points?: string; width?: number }) => (
  <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={width} strokeLinejoin="round" />
);

function Sparkle({ x, y, s, begin }: { x: number; y: number; s: number; begin: string }) {
  return (
    <path d={`M${x} ${y - s}Q${x} ${y} ${x + s} ${y}Q${x} ${y} ${x} ${y + s}Q${x} ${y} ${x - s} ${y}Q${x} ${y} ${x} ${y - s}Z`}
      fill="#fff7dc" opacity={0}>
      <animate attributeName="opacity" values="0;1;0;0" keyTimes="0;0.25;0.5;1" dur="2.6s" begin={begin} repeatCount="indefinite" />
    </path>
  );
}

function Star({ score, special, filled }: { score: number; special: boolean; filled: boolean }) {
  const uid = useId().replace(/:/g, "");
  const grad = (id: string, [top, bottom]: readonly [string, string]) => (
    <linearGradient id={`${id}${uid}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={top} />
      <stop offset="100%" stopColor={bottom} />
    </linearGradient>
  );
  const defs = (
    <defs>
      {grad("gold", GOLD)}
      {grad("dim", DIM)}
      <clipPath id={`clip${uid}`}><polygon points={STAR} /></clipPath>
      <linearGradient id={`sheen${uid}`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#fff" stopOpacity={0} />
        <stop offset="50%" stopColor="#fff" stopOpacity={0.65} />
        <stop offset="100%" stopColor="#fff" stopOpacity={0} />
      </linearGradient>
      <filter id={`halo${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" /></filter>
    </defs>
  );
  const gold = `url(#gold${uid})`;

  if (!special) {
    return filled ? <>{defs}<Shape fill={gold} /></> : <Shape fill="none" stroke={EMPTY} width={1.3} />;
  }

  // 1–3: две тусклые половины разошлись по трещине
  if (score <= 3) {
    const crack = "10.3,0 9.3,6.2 10.9,9.4 9,12.8 10.2,20";
    return (
      <>
        {defs}
        <clipPath id={`l${uid}`}><polygon points={`0,0 ${crack} 0,20`} /></clipPath>
        <clipPath id={`r${uid}`}><polygon points={`20,0 ${crack} 20,20`} /></clipPath>
        <g clipPath={`url(#l${uid})`} transform="rotate(-7 9 19) translate(-0.5 0)"><Shape fill={`url(#dim${uid})`} /></g>
        <g clipPath={`url(#r${uid})`} transform="rotate(8 11 19) translate(0.5 0.3)"><Shape fill={`url(#dim${uid})`} /></g>
      </>
    );
  }

  const engrave = score >= 9 ? ENGRAVE_LIGHT : ENGRAVE;
  return (
    <>
      {defs}
      {/* 10: тёплое сияние вокруг */}
      {score === 10 && (
        <circle cx={CX} cy={CY} r={7.5} fill={GOLD[1]} filter={`url(#halo${uid})`}>
          <animate attributeName="opacity" values="0.35;0.8;0.35" dur="2.6s" repeatCount="indefinite" />
        </circle>
      )}

      <Shape fill={gold} />

      {/* Гравировка: 4–5 одна линия, 6+ две; у 9–10 светлая, у 10 мерцает */}
      <g fill="none" stroke={engrave} strokeWidth={0.75} strokeLinejoin="round" opacity={score >= 9 ? 0.9 : 0.85}>
        <polygon points={LINE1} />
        {score >= 6 && <polygon points={LINE2} />}
        {score === 10 && <animate attributeName="opacity" values="0.5;1;0.5" dur="2.6s" repeatCount="indefinite" />}
      </g>

      {/* 8+: мягкий блик */}
      {score >= 8 && (
        <g clipPath={`url(#clip${uid})`}>
          <rect x={-8} y={-4} width={7} height={30} fill={`url(#sheen${uid})`} transform="rotate(20 10 10)">
            <animate attributeName="x" values="-8;-8;22" keyTimes="0;0.6;1" dur="3.2s" repeatCount="indefinite" />
          </rect>
        </g>
      )}

      {/* 9+: искры */}
      {score >= 9 && (
        <>
          <Sparkle x={17.6} y={2.6} s={2.4} begin="0s" />
          <Sparkle x={2.6} y={4.2} s={1.7} begin="0.9s" />
          {score === 10 && <Sparkle x={17.4} y={17.6} s={1.9} begin="1.7s" />}
        </>
      )}
    </>
  );
}

/** Одна звезда ряда: в форме оценки (special) или обычная. */
export function ScoreStar({ score, special, filled, size = 24 }: { score: number; special: boolean; filled: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} overflow="visible" aria-hidden>
      <Star score={score} special={special} filled={filled} />
    </svg>
  );
}

/** Ряд из 10 звёзд: наведённая (или выбранная) звезда — в форме своей оценки. */
export function RatingStars({ value, onChange, size = 24 }: { value: number; onChange: (n: number) => void; size?: number }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="flex" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button key={n} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)}
          onClick={() => onChange(n === value ? 0 : n)} aria-label={`Оценка ${n}`}
          className={cx("p-0.5 transition-transform duration-200", n === shown && "scale-115")}>
          <ScoreStar score={n} special={n === shown} filled={n <= shown} size={size} />
        </button>
      ))}
    </div>
  );
}
