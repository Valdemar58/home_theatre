"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { LANG_LABELS } from "@/lib/books";
import { api } from "@/lib/client";
import { Badge, Button, Chip, cx, ErrorBox, Skel, Spinner } from "../ui";

// Мосты к чужим расширениям (TASKS 5.9, админ): плагины LNReader (ранобэ, выполняются в календаре) и Suwayomi-Server
// (манга, отдельный контейнер профиля suwayomi). Что включено — в этом и ищут провайдеры «LNReader» и «Suwayomi».

type State = {
  lnreader: { index: string; enabled: string[]; plugins: { id: string; name: string; lang: string; site: string }[] | null };
  suwayomi: {
    up: boolean; version: string | null; error: string | null; url: string; repo: string; enabled: string[];
    extensions: { pkgName: string; name: string; lang: string; versionName: string; isInstalled: boolean; hasUpdate: boolean; isNsfw: boolean }[];
    sources: { id: string; name: string; lang: string; nsfw: boolean }[];
  };
};

const LANG_CHIPS = ["ru", "en", "ja", "all"];
const langName = (l: string) => (l === "all" ? "Все" : LANG_LABELS[l] ?? l);
const row = "flex items-center gap-3 px-3 py-1.5";
const input = "h-9 min-w-0 flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 text-sm focus:border-accent-500 focus:outline-none";

export function BridgesCard() {
  const qc = useQueryClient();
  const { data, error, isFetching } = useQuery({ queryKey: ["book-bridges"], queryFn: () => api<State>("/api/books/bridges") });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (method: "PUT" | "POST", json: unknown, label: string) => {
    setErr(null);
    setBusy(label);
    try {
      await api("/api/books/bridges", { method, json });
      await qc.invalidateQueries({ queryKey: ["book-bridges"] });
      await qc.invalidateQueries({ queryKey: ["book-providers"] });
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Skel className="h-60 w-full" />;
  return (
    <div className="space-y-6 text-sm">
      <p className="text-gray-400">Сотни сайтов через расширения других приложений. Их код — сторонний: включайте только нужное. Найденное появится у книг как провайдеры «LNReader» и «Suwayomi».</p>
      {err ? <ErrorBox error={err} /> : null}
      <Lnreader s={data.lnreader} busy={busy} save={(x) => void call("PUT", x, "ln")} />
      <Suwayomi s={data.suwayomi} busy={busy} refreshing={isFetching} call={call} />
    </div>
  );
}

function Lnreader({ s, busy, save }: { s: State["lnreader"]; busy: string | null; save: (x: { plugins?: string[]; index?: string }) => void }) {
  const [q, setQ] = useState("");
  const [lang, setLang] = useState("ru");
  const [index, setIndex] = useState(s.index);
  const list = useMemo(() => (s.plugins ?? [])
    .filter((p) => (lang === "all" || p.lang === lang) && (!q || `${p.name} ${p.site}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(s.enabled.includes(b.id)) - Number(s.enabled.includes(a.id)) || a.name.localeCompare(b.name)), [s, q, lang]);
  const toggle = (id: string) => save({ plugins: s.enabled.includes(id) ? s.enabled.filter((x) => x !== id) : [...s.enabled, id] });
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2"><h3 className="font-semibold">Плагины LNReader</h3><span className="text-gray-500">ранобэ · включено {s.enabled.length}</span>{busy === "ln" && <Spinner className="h-4 w-4" />}</div>
      {!s.plugins ? <p className="text-negative-300">Индекс плагинов не загрузился — проверьте адрес.</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Сайт или название плагина" className={input} />
            {LANG_CHIPS.map((l) => <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{langName(l)}</Chip>)}
          </div>
          <ul className="max-h-72 divide-y divide-gray-800 overflow-y-auto rounded-lg ring-1 ring-gray-700">
            {list.map((p) => (
              <li key={p.id}>
                <label className={cx(row, "cursor-pointer hover:bg-gray-800/60")}>
                  <input type="checkbox" checked={s.enabled.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="truncate text-xs text-gray-500">{p.site.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
                  <span className="w-20 shrink-0 text-right text-xs text-gray-500">{langName(p.lang)}</span>
                </label>
              </li>
            ))}
            {!list.length && <li className="px-3 py-4 text-center text-gray-500">Ничего не нашлось</li>}
          </ul>
        </>
      )}
      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer">Адрес индекса плагинов</summary>
        <div className="mt-2 flex gap-2">
          <input value={index} onChange={(e) => setIndex(e.target.value)} className={input} />
          <Button size="sm" disabled={index === s.index} onClick={() => save({ index })}>Сохранить</Button>
        </div>
      </details>
    </section>
  );
}

function Suwayomi({ s, busy, refreshing, call }: { s: State["suwayomi"]; busy: string | null; refreshing: boolean; call: (m: "PUT" | "POST", j: unknown, l: string) => Promise<void> }) {
  const [repo, setRepo] = useState(s.repo);
  const [lang, setLang] = useState("ru");
  const [q, setQ] = useState("");
  const exts = useMemo(() => s.extensions
    .filter((e) => (lang === "all" || e.lang === lang || e.lang === "all") && (!q || e.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(b.isInstalled) - Number(a.isInstalled) || a.name.localeCompare(b.name)), [s.extensions, lang, q]);
  const toggleSource = (id: string) => void call("PUT", { sources: s.enabled.includes(id) ? s.enabled.filter((x) => x !== id) : [...s.enabled, id] }, "src");
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Suwayomi</h3><span className="text-gray-500">манга</span>
        {s.up ? <Badge tone="positive">работает · {s.version}</Badge> : <Badge tone="negative">недоступен</Badge>}
        {refreshing && <Spinner className="h-4 w-4" />}
      </div>
      {!s.up ? (
        <p className="text-gray-400">Контейнер не запущен: добавьте профиль <code>suwayomi</code> в <code>COMPOSE_PROFILES</code> и поднимите стек. {s.error ? <span className="text-gray-500">({s.error})</span> : null}</p>
      ) : (
        <>
          <div className="space-y-1">
            <p className="text-xs text-gray-500">Репозиторий расширений Mihon — адрес его index.min.json. Встроенного нет: какой брать — решаете вы.</p>
            <div className="flex gap-2">
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://…/index.min.json" className={input} />
              <Button size="sm" disabled={repo === s.repo || busy === "repo"} onClick={() => void call("POST", { repo }, "repo")}>{busy === "repo" ? "Загружаю…" : "Сохранить"}</Button>
            </div>
          </div>
          {s.extensions.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Расширение" className={input} />
                {LANG_CHIPS.map((l) => <Chip key={l} active={lang === l} onClick={() => setLang(l)}>{langName(l)}</Chip>)}
              </div>
              <ul className="max-h-60 divide-y divide-gray-800 overflow-y-auto rounded-lg ring-1 ring-gray-700">
                {exts.map((e) => (
                  <li key={e.pkgName} className={row}>
                    <span className="min-w-0 flex-1 truncate">{e.name}{e.isNsfw && <span className="ml-1 text-xs text-warning-300">18+</span>}</span>
                    <span className="text-xs text-gray-500">{langName(e.lang)} · {e.versionName}</span>
                    {e.isInstalled ? (
                      <span className="flex gap-1">
                        {e.hasUpdate && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void call("POST", { update: e.pkgName }, e.pkgName)}>Обновить</Button>}
                        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void call("POST", { uninstall: e.pkgName }, e.pkgName)}>Удалить</Button>
                      </span>
                    ) : <Button size="sm" disabled={Boolean(busy)} onClick={() => void call("POST", { install: e.pkgName }, e.pkgName)}>{busy === e.pkgName ? "Ставлю…" : "Установить"}</Button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {s.sources.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">Источники установленных расширений — где искать книги:</p>
              <div className="flex flex-wrap gap-2">
                {s.sources.map((src) => (
                  <Chip key={src.id} active={s.enabled.includes(src.id)} onClick={() => toggleSource(src.id)}>{src.name} · {langName(src.lang)}</Chip>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
