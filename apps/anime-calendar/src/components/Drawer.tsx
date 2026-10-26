"use client";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { cx } from "./ui";

/** Выезжающая справа панель (на телефоне — снизу на весь экран). */
export function Drawer({ open, onClose, title, subtitle, actions, children, width = "sm:w-[36rem]" }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  return (
    <div className={cx("fixed inset-0 z-50 transition", open ? "visible" : "invisible")} aria-hidden={!open}>
      <div className={cx("absolute inset-0 bg-gray-950/70 backdrop-blur-sm transition-opacity", open ? "opacity-100" : "opacity-0")} onClick={onClose} />
      <aside
        className={cx(
          "absolute flex flex-col bg-gray-900 shadow-2xl ring-1 ring-gray-700 transition-transform duration-300",
          "inset-x-0 bottom-0 top-12 rounded-t-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:rounded-none",
          width,
          open ? "translate-y-0 sm:translate-x-0" : "translate-y-full sm:translate-x-full sm:translate-y-0",
        )}
      >
        <header className="flex items-start gap-3 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold first-letter:uppercase">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-gray-400">{subtitle}</div>}
          </div>
          {actions}
          <button onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Закрыть">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{open && children}</div>
      </aside>
    </div>
  );
}
