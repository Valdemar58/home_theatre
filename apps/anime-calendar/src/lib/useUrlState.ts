"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { filtersToParams, parseFilters, type Filters } from "./filters";

/** Фильтры и прочие параметры страницы живут в URL: ссылкой можно поделиться, «назад» работает. */
export function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
      router.replace(`${pathname}?${p}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const setFilters = useCallback(
    (f: Filters) => router.replace(`${pathname}?${filtersToParams(f, new URLSearchParams(params.toString()))}`, { scroll: false }),
    [params, pathname, router],
  );

  return { params, filters, setFilters, setParams };
}
