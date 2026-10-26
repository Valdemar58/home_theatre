// Дерево комментариев: ответ — дочерняя ветка. Верхний уровень — новые сверху, ответы — по порядку.
// Глубже MAX_DEPTH ветка не рисуется лесенкой, а открывается отдельно («Продолжить ветку»).

import type { CommentItem } from "./types";

export const MAX_DEPTH = 4;

export type CommentNode = CommentItem & { children: CommentNode[]; depth: number; total: number };

export function buildTree(items: CommentItem[], rootId: number | null = null): CommentNode[] {
  const byParent = new Map<number | null, CommentItem[]>();
  const ids = new Set(items.map((c) => c.id));
  for (const c of items) {
    // Родитель не виден (удалён без ответов или скрыт) — ответ поднимается на верхний уровень
    const parent = c.parentId !== null && ids.has(c.parentId) ? c.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  const build = (parent: number | null, depth: number): CommentNode[] => {
    const list = [...(byParent.get(parent) ?? [])].sort((a, b) =>
      parent === rootId && depth === 0 ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
    return list.map((c) => {
      const children = build(c.id, depth + 1);
      return { ...c, children, depth, total: children.reduce((s, ch) => s + 1 + ch.total, 0) };
    });
  };
  if (rootId === null) return build(null, 0);
  const root = items.find((c) => c.id === rootId);
  if (!root) return [];
  const children = build(rootId, 1);
  return [{ ...root, children, depth: 0, total: children.reduce((s, ch) => s + 1 + ch.total, 0) }];
}
