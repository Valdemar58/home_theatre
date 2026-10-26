"use client";
import { EllipsisHorizontalIcon, PlusIcon, StarIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolid } from "@heroicons/react/24/solid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { FilterPreset } from "@/lib/types";
import { useConfirm } from "./Dialogs";
import { Button, Modal, cx } from "./ui";

// Свои наборы фильтров каталога: «Свежак» = сортировка + фильтры одним кликом.
// Набор «по умолчанию» применяется, когда каталог открыт без параметров.

/** Параметры адреса без поиска и страницы, в постоянном порядке — для сравнения с набором. */
export function presetQuery(params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  p.delete("q");
  p.delete("page");
  p.sort();
  return p.toString();
}

export function FilterPresets() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const confirm = useConfirm();
  const { data: presets } = useQuery({ queryKey: ["presets"], queryFn: () => api<FilterPreset[]>("/api/presets"), staleTime: 60_000 });
  const [saving, setSaving] = useState<{ id?: number; name: string; isDefault: boolean } | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const applied = useRef(false);
  const current = presetQuery(params);
  const q = params.get("q");

  const apply = (query: string) => router.replace(`${pathname}?${query}${q ? `${query ? "&" : ""}q=${encodeURIComponent(q)}` : ""}`, { scroll: false });

  // Каталог без параметров — набор по умолчанию (один раз за заход на страницу)
  useEffect(() => {
    if (applied.current || !presets) return;
    applied.current = true;
    const def = presets.find((p) => p.isDefault);
    if (def && !current && !q) apply(def.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets]);

  const save = async (body: Partial<FilterPreset>) => {
    qc.setQueryData(["presets"], await api<FilterPreset[]>("/api/presets", { method: "POST", json: body }));
  };
  const remove = async (p: FilterPreset) => {
    setMenu(null);
    if (!(await confirm({ title: `Удалить набор «${p.name}»?`, confirm: "Удалить", danger: true }))) return;
    qc.setQueryData(["presets"], await api<FilterPreset[]>(`/api/presets?id=${p.id}`, { method: "DELETE" }));
  };

  const list = presets ?? [];
  const active = list.find((p) => p.query === current);

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <button onClick={() => apply("")}
        className={cx("h-8 rounded-full px-3 text-sm transition", !current ? "tone-accent solid" : "tone-neutral soft")}>
        Все
      </button>
      {list.map((p) => (
        <div key={p.id} className="relative flex">
          <button onClick={() => apply(p.query)} title={p.isDefault ? "Применяется при открытии каталога" : undefined}
            className={cx("inline-flex h-8 items-center gap-1.5 rounded-l-full pl-3 pr-2 text-sm transition", p.query === current ? "tone-accent solid" : "tone-neutral soft")}>
            {p.isDefault && <StarSolid className="h-3.5 w-3.5 opacity-80" />}
            {p.name}
          </button>
          <button onClick={() => setMenu(menu === p.id ? null : p.id)} aria-label="Действия с набором"
            className={cx("h-8 rounded-r-full border-l border-black/20 pl-1.5 pr-2 transition", p.query === current ? "tone-accent solid" : "tone-neutral soft")}>
            <EllipsisHorizontalIcon className="h-4 w-4" />
          </button>
          {menu === p.id && (
            <div className="absolute left-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-lg bg-gray-800 py-1 text-sm shadow-2xl ring-1 ring-gray-600" onMouseLeave={() => setMenu(null)}>
              <button className="block w-full px-3 py-2 text-left hover:bg-gray-700 disabled:text-gray-500" disabled={p.query === current}
                onClick={() => { setMenu(null); void save({ id: p.id, query: current }); }}>
                Заменить текущими фильтрами
              </button>
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-700"
                onClick={() => { setMenu(null); void save({ id: p.id, isDefault: !p.isDefault }); }}>
                <StarIcon className="h-4 w-4" />{p.isDefault ? "Не применять при открытии" : "Применять при открытии каталога"}
              </button>
              <button className="block w-full px-3 py-2 text-left hover:bg-gray-700" onClick={() => { setMenu(null); setSaving({ id: p.id, name: p.name, isDefault: p.isDefault }); }}>
                Переименовать
              </button>
              <button className="block w-full px-3 py-2 text-left text-negative-300 hover:bg-gray-700" onClick={() => remove(p)}>Удалить</button>
            </div>
          )}
        </div>
      ))}
      {current && !active && (
        <Button size="sm" variant="ghost" className="h-8" onClick={() => setSaving({ name: "", isDefault: false })}>
          <PlusIcon className="h-4 w-4" />Сохранить фильтры
        </Button>
      )}

      <Modal open={Boolean(saving)} onClose={() => setSaving(null)} title={saving?.id ? "Переименовать набор" : "Сохранить набор фильтров"}>
        {saving && (
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            if (!saving.name.trim()) return;
            await save(saving.id ? { id: saving.id, name: saving.name } : { name: saving.name, query: current, isDefault: saving.isDefault });
            setSaving(null);
          }}>
            <input value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} autoFocus maxLength={40}
              placeholder="Например: «Свежак»"
              className="h-10 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm focus:border-accent-500 focus:outline-none" />
            {!saving.id && (
              <>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" checked={saving.isDefault} onChange={(e) => setSaving({ ...saving, isDefault: e.target.checked })} className="accent-accent-500" />
                  Применять при открытии каталога
                </label>
                <p className="text-xs text-gray-500">Сохранятся текущие фильтры и сортировка (без строки поиска).</p>
              </>
            )}
            <div className="flex justify-end"><Button type="submit" variant="primary" disabled={!saving.name.trim()}>Сохранить</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
