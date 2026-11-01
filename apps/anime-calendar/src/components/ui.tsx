"use client";
// Базовые элементы в стиле Seerr.
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock } from "@/lib/useBodyScrollLock";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "default" | "success" | "danger" | "ghost";
  size?: "sm" | "md";
};

// Единая система элементов действий (кнопки, выбор статуса, счётчик серий): одна высота,
// скругление и рамка (ring внутри — не меняет размер). Залитая — только главная (primary);
// остальные нейтральные, состояние — лёгким оттенком цвета (success, статус в списке).
export const CONTROL_SIZES = { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5 text-sm" } as const;
export const CONTROL_BASE = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium ring-1 ring-inset transition";
export const CONTROL_NEUTRAL = "bg-gray-800/80 ring-gray-600 text-gray-100 hover:bg-gray-700";

const VARIANTS = {
  // Цвета — из палитры (globals.css): тон + вариант; наведение и disabled выводятся формулой
  primary: "tone-accent solid ring-transparent shadow-sm",
  default: CONTROL_NEUTRAL,
  success: "tone-positive soft",
  danger: "tone-negative solid ring-transparent",
  ghost: "ring-transparent hover:bg-gray-700/60 text-gray-300",
};

export function Button({ variant = "default", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        CONTROL_BASE,
        "disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        CONTROL_SIZES[size],
        VARIANTS[variant],
        className,
      )}
    />
  );
}

/** Семантические тона палитры (globals.css): цвет выбирается по смыслу, а не подбирается заново. */
export type Tone = "accent" | "special" | "positive" | "negative" | "warning" | "info" | "neutral";
export const TONE_CLASS: Record<Tone, string> = {
  accent: "tone-accent", special: "tone-special", positive: "tone-positive", negative: "tone-negative",
  warning: "tone-warning", info: "tone-info", neutral: "tone-neutral",
};

/** Тон прогноза «насколько понравится» — одинаковый везде (плашка, карточки, всплывающая). */
export const matchTone = (percent: number): Tone => (percent >= 85 ? "positive" : percent >= 65 ? "accent" : percent >= 40 ? "neutral" : "negative");

export function Badge({ tone = "neutral", variant = "soft", className, children }: {
  tone?: Tone; variant?: "soft" | "solid" | "outline"; className?: string; children: React.ReactNode;
}) {
  return (
    // Фиксированная высота: бейджи в одной строке (и обёрнутые в ссылку) одного размера
    <span className={cx("inline-flex h-6 max-w-full items-center rounded-full px-2.5 text-xs leading-none font-medium whitespace-nowrap",
      TONE_CLASS[tone], variant === "outline" ? "outline-tone" : variant, className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", !/\btext-/.test(className ?? "") && "text-indigo-400", className ?? "h-6 w-6")} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// Сколько окон открыто: всплывающая карточка тайтла не закрывается, пока из неё открыто окно
let openModals = 0;
export const modalsOpen = () => openModals > 0;

export function Modal({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useBodyScrollLock(open);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    openModals++;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { openModals--; window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open || !mounted) return null;
  // Портал: иначе окно внутри элемента с backdrop-blur/transform (шапка, всплывающая карточка) обрезается им
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-gray-900/80 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={title}
        className={cx("flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-xl bg-gray-800 shadow-2xl ring-1 ring-gray-700 sm:rounded-xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-700 px-5 py-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white" aria-label="Закрыть">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-700 px-6 py-16 text-center">
      <p className="text-lg font-semibold text-gray-200">{title}</p>
      {children && <div className="mt-2 max-w-md text-sm text-gray-400">{children}</div>}
    </div>
  );
}

/**
 * Заглушка на время загрузки — того же размера, что придёт (размер задаёт className). Правило приложения: всё,
 * что не зависит от данных (заголовки, ссылки, кнопки, раскладка), рисуется сразу; заглушкой — только место под данные.
 */
export function Skel({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block animate-pulse rounded-md bg-gray-700/50", className ?? "h-4 w-24")} />;
}

/** Абзац-заглушка: строки разной длины, последняя короче. */
export function SkelText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("block space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => <Skel key={i} className={cx("h-3.5", i === lines - 1 ? "w-3/5" : i % 2 ? "w-11/12" : "w-full")} />)}
    </span>
  );
}

/** Сетка постеров-заглушек 2:3 (карточки тайтлов и персонажей): классы сетки — те же, что у настоящей. */
export function SkelPosters({ count, className }: { count: number; className: string }) {
  return (
    <div aria-hidden className={className}>
      {Array.from({ length: count }, (_, i) => <Skel key={i} className="aspect-2/3 w-full rounded-xl" />)}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Chip({ active, negative, onClick, children }: {
  active?: boolean; negative?: boolean; onClick?: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-full border px-3 py-1 text-xs font-medium transition",
        negative
          ? "tone-negative soft border-transparent line-through"
          : active
            ? "tone-accent solid border-transparent"
            : "border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-500 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/** Переключатель из нескольких вариантов (сегменты). */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg ring-1 ring-inset ring-gray-600">
      {options.map(([v, text]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={cx("h-9 px-3 text-sm transition", value === v ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700")}>
          {text}
        </button>
      ))}
    </div>
  );
}
