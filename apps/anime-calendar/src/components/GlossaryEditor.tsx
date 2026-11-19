"use client";
import { ArrowPathIcon, LockClosedIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { TERM_KINDS, TERM_SOURCES, termNames, type Term, type TermKind } from "@/lib/glossary";
import { api, useMe } from "@/lib/client";
import { relative } from "@/lib/time";
import { Badge, Button, Chip, cx, EmptyState, ErrorBox, Skel, Spinner } from "./ui";

// Единый глоссарий франшизы (TASKS 5.6): имена, места и термины по-русски — для перевода серий, надписей, кадров и
// глав. Собирается из источников; ручная правка закрепляет термин (сборка его больше не меняет). Править — админу.

type Data = { root: number; title: string | null; collectedAt: number | null; collecting: boolean; terms: Term[] };
type Draft = { kind: TermKind; ru: string; en: string; ja: string; alts: string; note: string };
const emptyDraft: Draft = { kind: "name", ru: "", en: "", ja: "", alts: "", note: "" };
const draftOf = (t: Term): Draft => ({ kind: t.kind, ru: t.ru, en: t.en ?? "", ja: t.ja ?? "", alts: t.alts.join(", "), note: t.note ?? "" });
const fromDraft = (d: Draft) => ({ kind: d.kind, ru: d.ru, en: d.en, ja: d.ja, note: d.note, alts: d.alts.split(",").map((x) => x.trim()).filter(Boolean) });

export function GlossaryEditor({ anime, book }: { anime?: number; book?: number }) {
  const qs = anime ? `anime=${anime}` : `book=${book}`;
  const key = ["glossary", qs];
  const qc = useQueryClient();
  const { data: me } = useMe();
  const admin = Boolean(me?.isAdmin);
  const { data, error } = useQuery({
    queryKey: key, queryFn: () => api<Data>(`/api/glossary?${qs}`),
    refetchInterval: (q) => (q.state.data?.collecting ? 2000 : false),
  });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<TermKind | "all">("all");
  const [hidden, setHidden] = useState(false);
  const [edit, setEdit] = useState<number | "new" | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.terms ?? []).filter((t) => Boolean(t.hidden) === hidden && (kind === "all" || t.kind === kind)
      && (!s || [t.ru, ...termNames(t), t.note ?? ""].some((x) => x.toLowerCase().includes(s))));
  }, [data, q, kind, hidden]);

  const call = async (method: "POST" | "PUT", body: unknown) => {
    setErr(null);
    try {
      await api(`/api/glossary?${qs}`, { method, json: body });
      await qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (e) { setErr(e); return false; }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Skel className="h-60 w-full" />;
  const counts = Object.fromEntries((Object.keys(TERM_KINDS) as TermKind[]).map((k) => [k, data.terms.filter((t) => t.kind === k && !t.hidden).length]));
  const hiddenCount = data.terms.filter((t) => t.hidden).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-400">
        <span>{data.terms.length - hiddenCount} терминов{data.collectedAt ? ` · собрано ${relative(data.collectedAt)}` : " · ещё не собирался"}</span>
        {admin && (
          <Button size="sm" disabled={data.collecting} onClick={() => void call("POST", { collect: true })} className="ml-auto"
            title="Персонажи Shikimori (аниме и манга), граф сюжета, пересказ сезона. Ручное и закреплённое не меняется">
            {data.collecting ? <><Spinner className="h-4 w-4" />Собираю…</> : <><ArrowPathIcon className="h-4 w-4" />Собрать из источников</>}
          </Button>
        )}
        {admin && <Button size="sm" variant="primary" onClick={() => setEdit("new")}><PlusIcon className="h-4 w-4" />Термин</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по любому написанию"
          className="h-9 min-w-48 flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 text-sm focus:border-accent-500 focus:outline-none" />
        <Chip active={kind === "all"} onClick={() => setKind("all")}>Все</Chip>
        {(Object.keys(TERM_KINDS) as TermKind[]).filter((k) => counts[k]).map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{TERM_KINDS[k]} {counts[k]}</Chip>
        ))}
        {hiddenCount > 0 && <Chip active={hidden} onClick={() => setHidden(!hidden)}>Убранные {hiddenCount}</Chip>}
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {edit === "new" && <TermForm init={emptyDraft} onCancel={() => setEdit(null)} onSave={async (d) => { if (await call("POST", { term: fromDraft(d) })) setEdit(null); }} />}
      {!data.terms.length ? (
        <EmptyState title={data.collecting ? "Собираю глоссарий…" : "Глоссарий пуст"}>
          {admin ? "Нажмите «Собрать из источников» — имена персонажей, места и термины появятся здесь." : "Его ещё не собирали."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-gray-800 rounded-xl ring-1 ring-gray-700">
          {list.map((t) => edit === t.id ? (
            <li key={t.id} className="p-3"><TermForm init={draftOf(t)} onCancel={() => setEdit(null)} onSave={async (d) => { if (await call("PUT", { id: t.id, patch: fromDraft(d) })) setEdit(null); }} /></li>
          ) : (
            <li key={t.id} className={cx("flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2", t.proposed && "bg-warning-500/5")}>
              <Badge tone={t.kind === "name" ? "accent" : t.kind === "place" ? "info" : "special"}>{TERM_KINDS[t.kind]}</Badge>
              <span className="font-medium text-gray-100">{t.ru}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-400">{termNames(t).join(" · ")}{t.note ? <span className="text-gray-500"> — {t.note}</span> : null}</span>
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                {t.locked && <LockClosedIcon className="h-3.5 w-3.5 text-warning-300" aria-label="Закреплён" />}
                {t.proposed ? <Badge tone="warning">предложено ИИ</Badge> : TERM_SOURCES[t.source]}
              </span>
              {admin && (
                <span className="flex gap-1">
                  {t.proposed && <Button size="sm" variant="ghost" onClick={() => void call("PUT", { id: t.id, patch: { locked: true } })}>Принять</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setEdit(t.id!)}>Править</Button>
                  <Button size="sm" variant="ghost" onClick={() => void call("PUT", { id: t.id, patch: { hidden: !t.hidden } })}>{t.hidden ? "Вернуть" : "Убрать"}</Button>
                </span>
              )}
            </li>
          ))}
          {!list.length && <li className="px-3 py-6 text-center text-sm text-gray-500">Ничего не нашлось</li>}
        </ul>
      )}
    </div>
  );
}

function TermForm({ init, onSave, onCancel }: { init: Draft; onSave: (d: Draft) => void; onCancel: () => void }) {
  const [d, setD] = useState(init);
  const field = (k: keyof Draft, label: string, ph?: string) => (
    <label className="flex flex-col gap-1 text-xs text-gray-400">{label}
      <input value={d[k]} placeholder={ph} onChange={(e) => setD({ ...d, [k]: e.target.value })}
        className="h-9 rounded-lg border border-gray-600 bg-gray-800 px-2 text-sm text-gray-100 focus:border-accent-500 focus:outline-none" />
    </label>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(d); }} className="space-y-3 rounded-xl bg-gray-800/60 p-3 ring-1 ring-gray-700">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-gray-400">Вид
          <select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as TermKind })}
            className="h-9 rounded-lg border border-gray-600 bg-gray-800 px-2 text-sm text-gray-100">
            {(Object.keys(TERM_KINDS) as TermKind[]).map((k) => <option key={k} value={k}>{TERM_KINDS[k]}</option>)}
          </select>
        </label>
        {field("ru", "По-русски")}
        {field("en", "Латиницей / по-английски")}
        {field("ja", "По-японски")}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {field("alts", "Другие написания", "через запятую")}
        {field("note", "Заметка", "кто это, откуда")}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={!d.ru.trim() || !(d.en.trim() || d.ja.trim() || d.alts.trim())}>Сохранить</Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>Отмена</Button>
        <span className="self-center text-xs text-gray-500">Сохранённый вручную термин закрепляется — сборка его не меняет.</span>
      </div>
    </form>
  );
}
