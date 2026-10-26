"use client";
import { useEffect, useSyncExternalStore } from "react";
import { isCacheable } from "./img";

// ИИ-апскейл на клиенте: одно хранилище на вкладку.
//  • состояния картинок спрашиваем пачкой (один POST на кадр отрисовки, без дублей) — по паре
//    «картинка + размер показа»: карточке хватает обложки AniList, а крупно (шапка) нужен апскейл;
//  • пока есть «в работе» — одно SSE-соединение /api/img/events, готовые подменяются сами;
//  • «Показать оригинал» — для этой картинки во всей вкладке.

export type UpState = "done" | "pending" | "none";
export type UpSize = "card" | "full";
const k = (url: string, size: UpSize) => `${size}:${url}`;

const states = new Map<string, UpState>();
const originals = new Set<string>();
const listeners = new Set<() => void>();
let batch = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let events: EventSource | null = null;
let version = 0;

const emit = () => { version++; listeners.forEach((l) => l()); };

function ensureEvents() {
  const waiting = [...states.values()].includes("pending");
  if (waiting && !events) {
    events = new EventSource("/api/img/events");
    events.onmessage = (m) => {
      const { url, state } = JSON.parse(m.data) as { url: string; state: UpState };
      // Готовая картинка годится для любого размера, «none» — снимает только ожидание
      let hit = false;
      for (const size of ["card", "full"] as const) {
        const key = k(url, size);
        if (!states.has(key)) continue;
        hit = true;
        if (state === "done" || states.get(key) === "pending") states.set(key, state);
      }
      if (!hit) return;
      emit();
      ensureEvents();
    };
  } else if (!waiting && events) {
    events.close();
    events = null;
  }
}

function flush() {
  timer = null;
  const keys = [...batch];
  batch = new Set();
  if (!keys.length) return;
  const items = keys.map((key) => ({ size: key.slice(0, key.indexOf(":")), url: key.slice(key.indexOf(":") + 1) }));
  fetch("/api/img/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) })
    .then((r) => (r.ok ? r.json() : {}))
    .then((res: Record<string, UpState>) => {
      for (const key of keys) states.set(key, res[key] ?? "none");
      emit();
      ensureEvents();
    })
    .catch(() => undefined);
}

function request(url: string, size: UpSize) {
  const key = k(url, size);
  if (states.has(key) || batch.has(key) || !isCacheable(url)) return;
  batch.add(key);
  timer ??= setTimeout(flush, 50);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

/** Состояние апскейла картинки и переключатель «оригинал / улучшенная». */
export function useUpscale(url: string | null | undefined, size: UpSize, enabled = true) {
  useEffect(() => { if (url && enabled) request(url, size); }, [url, size, enabled]);
  useSyncExternalStore(subscribe, () => version, () => 0);
  const state: UpState = (url && states.get(k(url, size))) || "none";
  const original = Boolean(url && originals.has(url));
  return {
    state,
    /** Показывать улучшенную */
    upscaled: enabled && state === "done" && !original,
    original,
    toggle: () => {
      if (!url) return;
      if (originals.has(url)) originals.delete(url); else originals.add(url);
      emit();
    },
  };
}
