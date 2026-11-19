"use client";
import { ArrowDownIcon, ArrowUpIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LANG_LABELS } from "@/lib/books";
import { api } from "@/lib/client";
import { relative } from "@/lib/time";
import { Badge, Button, cx, ErrorBox, Skel } from "../ui";

// Провайдеры глав (Настройки, админ): порядок (на странице книги), включение,
// состояние источника и проверка связи, токен Lib для книг 18+.

type ProviderRow = { id: string; name: string; kinds: string[]; langs: string[]; enabled: boolean; down: boolean; lastError: string | null; lastOk: number | null };
type State = { providers: ProviderRow[]; libToken: string | null };
type Ping = { ok: boolean; ms: number; error?: string };

export function ProvidersCard() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["book-providers"], queryFn: () => api<State>("/api/books/providers") });
  const [pings, setPings] = useState<Record<string, Ping | "busy">>({});
  const [token, setToken] = useState("");
  const [err, setErr] = useState<unknown>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Skel className="h-40 w-full" />;
  const list = data.providers;

  const save = async (patch: Record<string, unknown>) => {
    setErr(null);
    try {
      await api("/api/books/providers", { method: "PUT", json: patch });
      await qc.invalidateQueries({ queryKey: ["book-providers"] });
    } catch (e) { setErr(e); }
  };
  const move = (i: number, d: number) => {
    const ids = list.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    void save({ order: ids });
  };
  const toggle = (p: ProviderRow) =>
    void save({ disabled: list.filter((x) => (x.id === p.id ? x.enabled : !x.enabled)).map((x) => x.id) });
  const ping = async (id: string) => {
    setPings((s) => ({ ...s, [id]: "busy" }));
    const r = await api<Ping>("/api/books/providers", { method: "POST", json: { id } }).catch((e: unknown) => ({ ok: false, ms: 0, error: String(e) }));
    setPings((s) => ({ ...s, [id]: r }));
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-gray-400">Откуда берутся главы манги и ранобэ. В этом порядке провайдеры стоят на странице книги; выключенный не обновляется, и его главы не видны.</p>
      <ul className="divide-y divide-gray-700/60 rounded-lg ring-1 ring-gray-700">
        {list.map((p, i) => {
          const r = pings[p.id];
          return (
            <li key={p.id} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2", !p.enabled && "opacity-60")}>
              <span className="flex flex-col">
                <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 text-gray-400 hover:text-white disabled:opacity-30" aria-label="Выше"><ArrowUpIcon className="h-3.5 w-3.5" /></button>
                <button disabled={i === list.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-gray-400 hover:text-white disabled:opacity-30" aria-label="Ниже"><ArrowDownIcon className="h-3.5 w-3.5" /></button>
              </span>
              <span className="min-w-0 basis-[calc(100%-2rem)] sm:basis-0 sm:flex-1">
                <span className="font-medium text-gray-100">{p.name}</span>
                <span className="ml-2 text-xs text-gray-500">{p.kinds.map((k) => (k === "novel" ? "ранобэ" : "манга")).join(", ")} · {p.langs.map((l) => LANG_LABELS[l] ?? l).join(", ")}</span>
                <span className="block text-xs">
                  {p.down ? <span className="text-negative-300">недоступен{p.lastError ? `: ${p.lastError.slice(0, 120)}` : ""}</span>
                    : p.lastOk ? <span className="text-gray-500">отвечал {relative(Math.floor(p.lastOk / 1000))}</span> : null}
                  {r && r !== "busy" && <span className={cx("ml-2", r.ok ? "text-positive-300" : "text-negative-300")}>{r.ok ? `связь есть, ${r.ms} мс` : `нет связи: ${r.error?.slice(0, 120)}`}</span>}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={r === "busy"} onClick={() => void ping(p.id)}>{r === "busy" ? "Проверяю…" : "Проверить"}</Button>
              <Button size="sm" variant={p.enabled ? "default" : "primary"} onClick={() => toggle(p)}>{p.enabled ? "Выключить" : "Включить"}</Button>
            </li>
          );
        })}
      </ul>
      <div className="space-y-2">
        <div className="flex items-center gap-2"><span className="font-medium">Вход в Lib</span>{data.libToken ? <Badge tone="positive">токен {data.libToken}</Badge> : <Badge tone="neutral">без входа</Badge>}</div>
        <p className="text-xs text-gray-500">Без входа MangaLib и RanobeLib не показывают книги 18+. Токен — из браузера, где выполнен вход на mangalib.me: DevTools → Application → Local Storage → <code>auth</code> → <code>token.access_token</code>.</p>
        <div className="flex flex-wrap gap-2">
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="access_token" type="password" autoComplete="off"
            className="h-9 min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 text-sm focus:border-accent-500 focus:outline-none" />
          <Button size="sm" disabled={!token.trim()} onClick={() => void save({ libToken: token }).then(() => setToken(""))}>Сохранить</Button>
          {data.libToken && <Button size="sm" variant="ghost" onClick={() => void save({ libToken: "" })}>Убрать</Button>}
        </div>
      </div>
      {err ? <ErrorBox error={err} /> : null}
    </div>
  );
}
