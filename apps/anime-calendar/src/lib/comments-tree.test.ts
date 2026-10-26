import { describe, expect, it } from "vitest";
import { buildTree } from "./comments-tree";
import type { CommentItem } from "./types";

const c = (id: number, parentId: number | null, createdAt: number): CommentItem => ({
  id, parentId, createdAt, user: { id: 1, name: "a" }, body: `#${id}`, spoiler: false, episode: null, editedAt: null, deleted: false, mine: false, score: null,
});

describe("buildTree", () => {
  const items = [c(1, null, 10), c(2, null, 20), c(3, 1, 30), c(4, 3, 40), c(5, 1, 35)];

  it("верхний уровень — новые сверху, ответы — по порядку", () => {
    const t = buildTree(items);
    expect(t.map((n) => n.id)).toEqual([2, 1]);
    expect(t[1].children.map((n) => n.id)).toEqual([3, 5]);
    expect(t[1].children[0].children[0].id).toBe(4);
  });

  it("глубина и число ответов в ветке", () => {
    const t = buildTree(items);
    expect(t[1].total).toBe(3);
    expect(t[1].children[0].children[0].depth).toBe(2);
  });

  it("ответ на невидимый комментарий — на верхнем уровне", () => {
    expect(buildTree([c(7, 99, 5)]).map((n) => n.id)).toEqual([7]);
  });

  it("отдельная ветка от выбранного комментария", () => {
    const t = buildTree(items, 3);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe(3);
    expect(t[0].children.map((n) => n.id)).toEqual([4]);
  });
});
