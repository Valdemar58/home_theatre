"use client";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

export function Toast({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss: () => void }) {
  return <div role="status" className="pointer-events-auto relative rounded-xl border border-gray-600 bg-gray-800 p-4 pr-12 text-sm text-gray-200 shadow-xl">
    <p className="font-medium text-gray-100">{title}</p>
    <div className="mt-1 leading-relaxed text-gray-300">{children}</div>
    <button aria-label="Закрыть уведомление" onClick={onDismiss} className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-700 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-300"><XMarkIcon className="h-4 w-4" /></button>
  </div>;
}
