"use client";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { EDIT_LABELS, type EditData, type EditKind } from "@/lib/plot-edits";
import type { PlotEditor as Editor } from "@/lib/types";
import { useAlert, useConfirm } from "./Dialogs";
import { Img } from "./Img";
import { Badge, Button, cx, ErrorBox, Modal, Skel } from "./ui";

// Правка персонажа в графе сюжета (IDEAS #81, этап 1 — админ): связь с AniList, «одно лицо» и разделение, имя
// и описание с серии N, картинка. Правка — слой поверх графа: переживает пересборку, отменяется из журнала.

const field = "h-9 rounded-lg border border-gray-600 bg-gray-900 px-2 text-sm focus:border-accent-500 focus:outline-none";

/** Кнопка «Править» (только админ, только у персонажа из разбора серий). */
export function PlotEditButton({ entityId, anilistId }: { entityId: number; anilistId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><PencilSquareIcon className="h-4 w-4" />Править</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Правка персонажа" wide>
        {open && <EditorBody entityId={entityId} anilistId={anilistId} onClose={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function EditorBody({ entityId, anilistId, onClose }: { entityId: number; anilistId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const key = ["plot-editor", entityId, anilistId];
  const { data: ed, error, isLoading } = useQuery({ queryKey: key, queryFn: () => api<Editor>(`/api/plot-edits?entity=${entityId}&anilistId=${anilistId}`) });

  const refresh = async (href?: string | null) => {
    await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["character"] }), qc.invalidateQueries({ queryKey: ["cast"] })]);
    // Привязка к AniList меняет адрес персонажа
    if (href && href !== location.pathname) { onClose(); router.replace(href); }
  };
  const save = async <K extends EditKind>(kind: K, data: EditData[K], fromEp: number) => {
    setBusy(true);
    try {
      const r = await api<{ id: number; href: string | null }>("/api/plot-edits", { method: "POST", json: { entityId, anilistId, kind, data, fromEp } });
      await refresh(r.href);
    } catch (e) {
      await alert({ title: "Правка не сохранилась", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const undo = async (id: number) => {
    if (!(await confirm({ title: "Отменить правку?", text: "Граф вернётся к тому, что решила модель (и другие правки).", confirm: "Отменить правку" }))) return;
    setBusy(true);
    try {
      await api(`/api/plot-edits/${id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !ed) return <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skel key={i} className="h-16 w-full rounded-lg" />)}</div>;
  return (
    <div className={cx("space-y-6 text-sm", busy && "pointer-events-none opacity-60")}>
      <p className="text-gray-400">
        Правка накладывается поверх разбора серий и переживает пересборку. «С серии» — когда зритель это узнаёт: раньше этой серии правку не покажут.
      </p>
      <AnilistPart ed={ed} onSave={(charId) => save("anilist", { charId }, 0)} />
      <SamePart ed={ed} onSame={(other, ep, note) => save("same", { other, note }, ep)} onSplit={(other) => save("split", { other }, 0)} />
      <NamePart ed={ed} onSave={(name, ep) => save("name", { name }, ep)} />
      <NotePart ed={ed} onSave={(description, goal, ep) => save("note", { description, goal }, ep)} />
      <ImagePart ed={ed} onSave={(url, label, ep) => save("image", { url, label }, ep)} />
      <Journal ed={ed} onUndo={undo} />
    </div>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg bg-gray-900/60 p-4 ring-1 ring-gray-700">
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
}

/** «С серии N» — от 1 до числа серий тайтла (0 — известно до первой серии). */
function EpInput({ ed, value, onChange }: { ed: Editor; value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-gray-400">с серии
      <input type="number" min={0} max={ed.total ?? undefined} value={value} onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))} className={cx(field, "w-20")} />
    </label>
  );
}

function AnilistPart({ ed, onSave }: { ed: Editor; onSave: (charId: number) => void }) {
  const [pick, setPick] = useState(ed.anilistCharId ?? 0);
  const cur = ed.candidates.find((c) => c.id === ed.anilistCharId);
  return (
    <Part title="Персонаж AniList">
      <p className="text-gray-400">Сейчас: {cur ? `${cur.name}${cur.native ? ` (${cur.native})` : ""}` : "не связан"}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={pick} onChange={(e) => setPick(Number(e.target.value))} className={cx(field, "min-w-0 flex-1")}>
          <option value={0}>Не связан с AniList</option>
          {ed.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.native ? ` · ${c.native}` : ""}{c.role === "MAIN" ? " · главный" : ""}</option>)}
        </select>
        <Button size="sm" disabled={pick === (ed.anilistCharId ?? 0)} onClick={() => onSave(pick)}>Сохранить</Button>
      </div>
    </Part>
  );
}

function SamePart({ ed, onSame, onSplit }: { ed: Editor; onSame: (other: string, ep: number, note: string) => void; onSplit: (other: string) => void }) {
  const [other, setOther] = useState("");
  const [ep, setEp] = useState(1);
  const [note, setNote] = useState("");
  return (
    <Part title="Одно лицо">
      {ed.identities.length ? (
        <ul className="space-y-1">
          {ed.identities.map((i, n) => (
            <li key={n} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{i.name} <span className="text-gray-500">· узнают с {i.ep} серии</span></span>
              {i.otherKey && <Button size="sm" variant="ghost" onClick={() => onSplit(i.otherKey!)}>Это разные люди</Button>}
            </li>
          ))}
        </ul>
      ) : <p className="text-gray-500">Ни с кем не склеен.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select value={other} onChange={(e) => setOther(e.target.value)} className={cx(field, "min-w-0 flex-1")}>
          <option value="">Это тот же персонаж, что…</option>
          {ed.others.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
        </select>
        <EpInput ed={ed} value={ep} onChange={setEp} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Как это раскрылось (необязательно)" className={cx(field, "min-w-0 flex-1")} />
        <Button size="sm" disabled={!other} onClick={() => onSame(other, ep, note)}>Склеить</Button>
      </div>
    </Part>
  );
}

function NamePart({ ed, onSave }: { ed: Editor; onSave: (name: string, ep: number) => void }) {
  const [name, setName] = useState("");
  const [ep, setEp] = useState(ed.names[0]?.fromEp ?? 1);
  return (
    <Part title="Имя">
      <p className="text-gray-400">
        Лента имён: {ed.names.filter((n) => n.anilistId === ed.anilistId).map((n) => `${n.name} (с ${n.fromEp})`).join(" → ") || ed.name}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя по-русски" className={cx(field, "min-w-0 flex-1")} />
        <EpInput ed={ed} value={ep} onChange={setEp} />
        <Button size="sm" disabled={!name.trim()} onClick={() => onSave(name, ep)}>Сохранить</Button>
      </div>
      <p className="text-xs text-gray-500">Имя с той же серии заменяется; если это последнее имя в ленте — оно становится основным.</p>
    </Part>
  );
}

function NotePart({ ed, onSave }: { ed: Editor; onSave: (description: string, goal: string, ep: number) => void }) {
  const mine = ed.notes.filter((n) => n.anilistId === ed.anilistId);
  const [text, setText] = useState(mine.at(-1)?.description ?? "");
  const [goal, setGoal] = useState("");
  const [ep, setEp] = useState(1);
  return (
    <Part title="Описание">
      {mine.length > 0 && (
        <details className="text-gray-400">
          <summary className="cursor-pointer">Описания модели по сериям ({mine.length})</summary>
          <ul className="mt-2 space-y-1.5">{mine.map((n) => <li key={n.upTo}><span className="text-gray-500">к {n.upTo} серии:</span> {n.description}</li>)}</ul>
        </details>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Кто это — только то, что зритель знает к этой серии"
        className="w-full rounded-lg border border-gray-600 bg-gray-900 p-2 text-sm focus:border-accent-500 focus:outline-none" />
      <div className="flex flex-wrap items-center gap-2">
        <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Цель (необязательно)" className={cx(field, "min-w-0 flex-1")} />
        <EpInput ed={ed} value={ep} onChange={setEp} />
        <Button size="sm" disabled={!text.trim()} onClick={() => onSave(text, goal, ep)}>Сохранить</Button>
      </div>
      <p className="text-xs text-gray-500">С этой серии вместо описаний модели — это, до следующей правки.</p>
    </Part>
  );
}

function ImagePart({ ed, onSave }: { ed: Editor; onSave: (url: string, label: string, ep: number) => void }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [ep, setEp] = useState(1);
  return (
    <Part title="Картинка">
      {ed.images.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {ed.images.map((i) => (
            <div key={i.url} className="w-20 shrink-0 space-y-1">
              <div className="relative aspect-2/3 overflow-hidden rounded-md bg-gray-800"><Img src={i.url} size="thumb" className="absolute inset-0 h-full w-full object-cover" /></div>
              <p className="truncate text-[11px] text-gray-500">{i.source}{i.fromEp !== null ? ` · с ${i.fromEp}` : ""}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… ссылка на картинку" className={cx(field, "min-w-0 flex-1")} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Подпись" className={cx(field, "w-36")} />
        <EpInput ed={ed} value={ep} onChange={setEp} />
        <Button size="sm" disabled={!/^https:\/\//.test(url)} onClick={() => onSave(url, label, ep)}>Добавить</Button>
      </div>
    </Part>
  );
}

function Journal({ ed, onUndo }: { ed: Editor; onUndo: (id: number) => void }) {
  if (!ed.edits.length) return null;
  return (
    <Part title="Правки">
      <ul className="space-y-1.5">
        {ed.edits.map((e) => (
          <li key={e.id} className={cx("flex items-center gap-2", e.undone && "opacity-50")}>
            <Badge tone={e.undone ? "neutral" : "accent"}>{EDIT_LABELS[e.kind]}</Badge>
            <span className="min-w-0 flex-1 truncate">{e.text}{e.fromEp ? <span className="text-gray-500"> · с {e.fromEp} серии</span> : null}</span>
            <span className="shrink-0 text-xs text-gray-500">{e.author} · {new Date(e.at * 1000).toLocaleDateString("ru-RU")}</span>
            {e.undone ? <span className="shrink-0 text-xs text-gray-500">отменена</span> : <Button size="sm" variant="ghost" onClick={() => onUndo(e.id)}>Отменить</Button>}
          </li>
        ))}
      </ul>
    </Part>
  );
}
