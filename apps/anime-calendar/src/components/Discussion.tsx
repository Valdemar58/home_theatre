"use client";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useMe } from "@/lib/client";
import { buildTree, MAX_DEPTH, type CommentNode } from "@/lib/comments-tree";
import { ago } from "@/lib/time";
import type { CommentItem } from "@/lib/types";
import { Avatar } from "./Avatar";
import { Button, cx } from "./ui";
import { useConfirm } from "./Dialogs";

// Обсуждение под тайтлом: комментарии друзей (и открытых профилей) с ветками ответов,
// спойлеры под размытием, правка/удаление своих. Глубокие ветки — «Продолжить ветку».

function Composer({ onSubmit, initial, autoFocus, submitText = "Отправить", onCancel, withEpisode }: {
  onSubmit: (p: { body: string; spoiler: boolean; episode: number | null }) => Promise<void>;
  initial?: { body: string; spoiler: boolean };
  autoFocus?: boolean;
  submitText?: string;
  onCancel?: () => void;
  withEpisode?: boolean;
}) {
  const [body, setBody] = useState(initial?.body ?? "");
  const [spoiler, setSpoiler] = useState(initial?.spoiler ?? false);
  const [episode, setEpisode] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Поле растёт по тексту
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 320)}px`; }
  }, [body]);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ body, spoiler, episode: Number(episode) || null });
      setBody("");
      setSpoiler(false);
      setEpisode("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} autoFocus={autoFocus} rows={2}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send(); }}
        placeholder="Что думаете?" maxLength={4000}
        className="w-full resize-none rounded-lg border border-gray-600 bg-gray-900/70 px-3 py-2 text-sm leading-relaxed focus:border-indigo-500 focus:outline-none" />
      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={spoiler} onChange={(e) => setSpoiler(e.target.checked)} className="accent-amber-500" />
          спойлер
        </label>
        {withEpisode && (
          <label className="flex items-center gap-1.5">
            к серии
            <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="—"
              className="h-7 w-12 rounded border border-gray-600 bg-gray-900 text-center text-sm focus:border-indigo-500 focus:outline-none" />
          </label>
        )}
        <span className="ml-auto flex gap-2">
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Отмена</Button>}
          <Button size="sm" variant="primary" disabled={busy || !body.trim()} onClick={send} title="Ctrl+Enter">{submitText}</Button>
        </span>
      </div>
    </div>
  );
}

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{children}</>;
  return (
    <button onClick={() => setOpen(true)} className="group relative block w-full text-left">
      <span className="block select-none blur-sm">{children}</span>
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-200 ring-1 ring-amber-500/40 group-hover:bg-amber-500/30">Спойлер — показать</span>
      </span>
    </button>
  );
}

function Comment({ node, anilistId, isAdmin, highlight, onFocus, refresh }: {
  node: CommentNode; anilistId: number; isAdmin: boolean; highlight: number | null; onFocus: (id: number) => void; refresh: () => void;
}) {
  const [reply, setReply] = useState(false);
  const [edit, setEdit] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const confirm = useConfirm();
  const c = node;
  const canEdit = !c.deleted && (c.mine || isAdmin);
  const post = (p: { body: string; spoiler: boolean; episode: number | null }) =>
    api(`/api/anime/${anilistId}/comments`, { method: "POST", json: { ...p, parentId: c.id } }).then(() => { setReply(false); refresh(); });
  const save = (p: { body: string; spoiler: boolean }) =>
    api(`/api/comments/${c.id}`, { method: "PATCH", json: { body: p.body, spoiler: p.spoiler } }).then(() => { setEdit(false); refresh(); });
  const remove = async () => {
    if (!(await confirm({ title: "Удалить комментарий?", text: c.children.length ? "Ответы на него останутся." : undefined, confirm: "Удалить", danger: true }))) return;
    await api(`/api/comments/${c.id}`, { method: "DELETE" });
    refresh();
  };
  const deep = c.depth >= MAX_DEPTH && c.children.length > 0;

  return (
    <li id={`c${c.id}`} className="scroll-mt-24">
      <div className={cx("flex gap-3 rounded-lg p-2 transition", highlight === c.id && "bg-indigo-500/10 ring-1 ring-indigo-500/40")}>
        {c.deleted ? <span className="h-8 w-8 shrink-0 rounded-full bg-gray-800" /> : <Link href={`/users/${c.user.id}`}><Avatar user={c.user} /></Link>}
        <div className="min-w-0 flex-1">
          {c.deleted ? <p className="py-1 text-sm italic text-gray-500">Комментарий удалён</p> : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <Link href={`/users/${c.user.id}`} className="font-semibold hover:text-indigo-300">{c.user.name}</Link>
                {c.score !== null && <span className="text-xs font-semibold text-amber-300" title="Его оценка тайтла">★ {c.score}</span>}
                {c.episode !== null && <span className="rounded bg-gray-700 px-1.5 text-[11px] text-gray-300">серия {c.episode}</span>}
                <span className="text-xs text-gray-500" title={new Date(c.createdAt * 1000).toLocaleString("ru-RU")}>
                  {ago(c.createdAt)}{c.editedAt && " · изменён"}
                </span>
              </div>
              {edit ? (
                <div className="mt-1"><Composer initial={{ body: c.body, spoiler: c.spoiler }} autoFocus submitText="Сохранить" onSubmit={save} onCancel={() => setEdit(false)} /></div>
              ) : (
                <div className="mt-0.5 whitespace-pre-line wrap-break-word text-sm leading-relaxed text-gray-200">
                  {c.spoiler ? <Spoiler>{c.body}</Spoiler> : c.body}
                </div>
              )}
            </>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            {!c.deleted && <button onClick={() => setReply(!reply)} className="hover:text-gray-200">Ответить</button>}
            {canEdit && !edit && <button onClick={() => setEdit(true)} className="hover:text-gray-200">Изменить</button>}
            {canEdit && <button onClick={remove} className="hover:text-red-300">Удалить</button>}
            {c.children.length > 0 && !deep && (
              <button onClick={() => setCollapsed(!collapsed)} className="hover:text-gray-200">
                {collapsed ? `Показать ответы (${c.total})` : "Свернуть ветку"}
              </button>
            )}
          </div>
          {reply && <div className="mt-2"><Composer autoFocus submitText="Ответить" onSubmit={post} onCancel={() => setReply(false)} /></div>}
        </div>
      </div>
      {deep ? (
        <button onClick={() => onFocus(c.id)} className="ml-11 mt-1 text-xs text-indigo-300 hover:text-indigo-200">Продолжить ветку ({c.total}) →</button>
      ) : c.children.length > 0 && !collapsed && (
        <ul className="ml-4 space-y-1 border-l border-gray-700/70 pl-3 sm:ml-6 sm:pl-4">
          {c.children.map((ch) => <Comment key={ch.id} node={ch} anilistId={anilistId} isAdmin={isAdmin} highlight={highlight} onFocus={onFocus} refresh={refresh} />)}
        </ul>
      )}
    </li>
  );
}

/**
 * Обсуждение тайтла; episode — только ветки этой серии (по первому комментарию ветки, ответы — вместе с ней),
 * новый комментарий сразу помечается серией. Данные общие с обсуждением на странице тайтла.
 */
export function Discussion({ anilistId, highlight, episode }: { anilistId: number; highlight?: number; episode?: number }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: all } = useQuery({ queryKey: ["comments", anilistId], queryFn: () => api<CommentItem[]>(`/api/anime/${anilistId}/comments`), staleTime: 30_000 });
  const data = useMemo(() => {
    if (!all || !episode) return all;
    const byId = new Map(all.map((c) => [c.id, c]));
    const root = (c: CommentItem) => {
      let r = c;
      while (r.parentId !== null && byId.has(r.parentId)) r = byId.get(r.parentId)!;
      return r;
    };
    return all.filter((c) => root(c).episode === episode);
  }, [all, episode]);
  const [focus, setFocusState] = useState<number | null>(null);
  const top = useRef<HTMLElement>(null);
  // Ветка открывается вместо всего обсуждения — вернуть взгляд к его началу
  const setFocus = (id: number | null) => { setFocusState(id); requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const scrolled = useRef(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["comments", anilistId] });

  // Пришли из уведомления об ответе — показать этот комментарий (глубоко — открыть его ветку)
  useEffect(() => {
    if (!highlight || !data || scrolled.current) return;
    scrolled.current = true;
    // Цепочка предков; лесенкой рисуется до глубины MAX_DEPTH — глубже открываем ветку от предка на этой глубине
    const parent = new Map(data.map((c) => [c.id, c.parentId]));
    const chain: number[] = [];
    for (let id: number | null | undefined = highlight; id != null; id = parent.get(id)) chain.unshift(id);
    if (chain.length - 1 > MAX_DEPTH) setFocusState(chain[chain.length - 1 - MAX_DEPTH]);
    setTimeout(() => document.getElementById(`c${highlight}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }, [highlight, data]);

  const tree = data ? buildTree(data, focus) : [];
  const count = data?.filter((c) => !c.deleted).length ?? 0;
  return (
    <section ref={top} className="scroll-mt-20">
      <h2 className="mb-3 flex items-center gap-2 text-xl font-bold">
        <ChatBubbleLeftRightIcon className="h-6 w-6 text-gray-400" />{episode ? `Обсуждение ${episode} серии` : "Обсуждение"} {count > 0 && <span className="text-base font-normal text-gray-500">{count}</span>}
      </h2>
      <div className="space-y-4 rounded-xl bg-gray-800/40 p-4 ring-1 ring-gray-700">
        {focus === null ? (
          <Composer withEpisode={!episode} onSubmit={(p) => api(`/api/anime/${anilistId}/comments`, { method: "POST", json: { ...p, episode: episode ?? p.episode } }).then(refresh)} />
        ) : (
          <button onClick={() => setFocus(null)} className="text-sm text-indigo-300 hover:text-indigo-200">← Ко всему обсуждению</button>
        )}
        {tree.length ? (
          <ul className="space-y-2">
            {tree.map((n) => <Comment key={n.id} node={n} anilistId={anilistId} isAdmin={Boolean(me?.isAdmin)} highlight={highlight ?? null} onFocus={setFocus} refresh={refresh} />)}
          </ul>
        ) : data && <p className="text-sm text-gray-500">Пока никто ничего не написал. Комментарии видят ваши друзья.</p>}
      </div>
    </section>
  );
}
