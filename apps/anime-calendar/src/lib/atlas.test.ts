import { describe, expect, it } from "vitest";
import { clusterColors, hslHex, islandBlobs, islandRadius, mergeSmall, nodeSize, packIslands, relaxOverlaps, shapeIsland, simStep, type SimNode } from "./atlas";

describe("карта тайтлов", () => {
  it("цвета островов различимы и в hex", () => {
    const c = clusterColors(30);
    expect(new Set(c).size).toBe(30);
    for (const x of c) expect(x).toMatch(/^#[0-9a-f]{6}$/);
    expect(hslHex(0, 1, 0.5)).toBe("#ff0000");
  });

  it("знаменитое крупнее", () => {
    expect(nodeSize(1_000_000)).toBeGreaterThan(nodeSize(100_000));
    expect(nodeSize(100_000)).toBeGreaterThan(nodeSize(5_000));
    expect(nodeSize(0)).toBeCloseTo(1.6);
  });

  it("мелкое сообщество уходит к острову, с которым больше связей", () => {
    const comm = new Map([[1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1], [7, 2]]);
    const edges: [number, number, number][] = [[7, 1, 1], [7, 4, 3], [7, 5, 1]];
    const out = mergeSmall(comm, edges, 3);
    expect(out.get(7)).toBe(1);
    expect(out.get(1)).toBe(0);
  });

  it("без связей мелкое остаётся", () => {
    const out = mergeSmall(new Map([[1, 0], [2, 0], [3, 0], [9, 5]]), [], 3);
    expect(out.get(9)).toBe(5);
  });

  it("пятна островов — по клеткам и островам", () => {
    const blobs = islandBlobs([{ x: 1, y: 1, cluster: 0 }, { x: 2, y: 2, cluster: 0 }, { x: 1, y: 1, cluster: 1 }, { x: 50, y: 50, cluster: 0 }], 10);
    expect(blobs).toHaveLength(3);
    expect(blobs.find((b) => b[3] === 0 && b[0] < 10)!.slice(0, 2)).toEqual([1.5, 1.5]);
  });

  it("перетаскивание: связанный узел тянется следом, сильная связь — сильнее, потом всё затихает", () => {
    const mk = (x: number, fixed = false): SimNode => ({ x, y: 0, vx: 0, vy: 0, r: 3, fixed });
    // 0 — тянем (закреплён под курсором), 1 и 2 — соседи с сильной и слабой связью, 3 — опора
    const nodes = [mk(0, true), mk(20), mk(-20), mk(100, true)];
    nodes[2].y = 20;
    const links = [{ a: 0, b: 1, rest: 20, k: 0.2 }, { a: 0, b: 2, rest: 28, k: 0.03 }, { a: 1, b: 3, rest: 80, k: 0.05 }, { a: 2, b: 3, rest: 122, k: 0.05 }];
    nodes[0].x = -100;
    for (let i = 0; i < 60; i++) simStep(nodes, links, 1);
    expect(nodes[1].x).toBeLessThan(0);
    expect(nodes[1].x).toBeLessThan(nodes[2].x + 30);
    // Отпустили: узел свободен, остывает
    nodes[0].fixed = false;
    let alpha = 1;
    let e = Infinity;
    for (let i = 0; i < 400 && e > 0.01; i++) { alpha *= 0.97; e = simStep(nodes, links, alpha); }
    expect(e).toBeLessThan(0.01);
  });

  it("точки не налезают друг на друга", () => {
    const nodes: SimNode[] = [{ x: 0, y: 0, vx: 0, vy: 0, r: 5, fixed: true }, { x: 1, y: 0, vx: 0, vy: 0, r: 5, fixed: false }];
    for (let i = 0; i < 50; i++) simStep(nodes, [], 1);
    expect(nodes[1].x).toBeGreaterThan(10);
  });

  it("острова не налезают друг на друга, связанные — ближе", () => {
    const radii = [300, 200, 150, 80, 60, 40].map((r) => r);
    const links = new Map([["0:5", 1]]);
    const pos = packIslands(radii, links, 40);
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      expect(Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y)).toBeGreaterThanOrEqual(radii[i] + radii[j] + 39);
    }
    const d = (a: number, b: number) => Math.hypot(pos[a].x - pos[b].x, pos[a].y - pos[b].y) - radii[a] - radii[b];
    expect(d(0, 5)).toBeLessThan(d(0, 4) + 1);
    expect(islandRadius(400)).toBeGreaterThan(islandRadius(100));
  });

  it("остров укладывается в круг, наложения убираются", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: Math.cos(i) * (i % 7), y: Math.sin(i) * (i % 5) }));
    const shaped = shapeIsland(pts, 100);
    for (const p of shaped) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(100.01);
    const sizes = shaped.map(() => 3);
    relaxOverlaps(shaped, sizes, 1, 40);
    let overlaps = 0;
    for (let i = 0; i < shaped.length; i++) for (let j = i + 1; j < shaped.length; j++) {
      if (Math.hypot(shaped[i].x - shaped[j].x, shaped[i].y - shaped[j].y) < 6.5) overlaps++;
    }
    expect(overlaps).toBeLessThan(5);
  });
});
