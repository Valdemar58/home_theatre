// Карта событий: раскладки «Дорожки» (сюжетные линии по сериям) и «Цепочка» (что к событию привело и к чему оно привело).

type Ev = { key: string; epFrom: number | null; epTo: number | null; participants: { id: number; name: string }[]; causes: { key: string }[]; consequences: { key: string }[] };

export type Lane = { id: number | null; name: string; rows: number };
/** to — последняя серия события; end — до какой серии полоса занята (подпись длиннее одной серии) */
export type LaneItem = { key: string; lane: number; row: number; from: number; to: number; end: number };

/**
 * Дорожки — самые частые участники событий (до maxLanes): главный герой — своя дорожка, остальные события ложатся
 * на дорожку самого «узкого» своего участника (у кого событий меньше — тот точнее говорит, чья это линия).
 * Внутри дорожки события одной серии не налезают: следующее — в новый ряд.
 */
export function laneLayout(events: Ev[], maxLanes = 6, minSpan = 3): { lanes: Lane[]; items: LaneItem[] } {
  const count = new Map<number, { name: string; n: number }>();
  for (const e of events) for (const p of e.participants) count.set(p.id, { name: p.name, n: (count.get(p.id)?.n ?? 0) + 1 });
  const top = [...count].sort((a, b) => b[1].n - a[1].n).slice(0, maxLanes);
  const lanes: Lane[] = top.map(([id, c]) => ({ id, name: c.name, rows: 1 }));
  const other = { id: null, name: "Прочее", rows: 1 };
  const laneOf = (e: Ev) => {
    const mine = top.map(([id], i) => ({ id, i })).filter((l) => e.participants.some((p) => p.id === l.id));
    if (!mine.length) return -1;
    // Самая «узкая» линия из тех, где он есть: у главного героя событий больше всех — его дорожка последняя по выбору
    return mine.sort((a, b) => count.get(a.id)!.n - count.get(b.id)!.n)[0].i;
  };
  const items: LaneItem[] = [];
  const ends = new Map<number, number[]>();
  for (const e of [...events].sort((a, b) => (a.epFrom ?? 0) - (b.epFrom ?? 0))) {
    const from = e.epFrom ?? 1, to = Math.max(from, e.epTo ?? from);
    const end = Math.max(to, from + minSpan - 1);
    let lane = laneOf(e);
    if (lane < 0) { if (!lanes.includes(other)) lanes.push(other); lane = lanes.indexOf(other); }
    const rowEnds = ends.get(lane) ?? [];
    let row = rowEnds.findIndex((x) => x < from);
    if (row < 0) { row = rowEnds.length; rowEnds.push(end); } else rowEnds[row] = end;
    ends.set(lane, rowEnds);
    lanes[lane].rows = Math.max(lanes[lane].rows, rowEnds.length);
    items.push({ key: e.key, lane, row, from, to, end });
  }
  return { lanes, items };
}

/**
 * «Цепочка» вокруг события: причины по шагам назад (до depth), последствия — вперёд. Колонка — шаг от события
 * (отрицательная — причины), внутри колонки — порядок появления.
 */
export function chainLayout(events: Ev[], center: string, depth = 4): { key: string; col: number; row: number }[] {
  const byKey = new Map(events.map((e) => [e.key, e]));
  const col = new Map<string, number>([[center, 0]]);
  let front = [center];
  for (let d = 1; d <= depth && front.length; d++) {
    front = front.flatMap((k) => byKey.get(k)?.causes.map((c) => c.key) ?? []).filter((k) => byKey.has(k) && !col.has(k));
    for (const k of front) col.set(k, -d);
  }
  front = [center];
  for (let d = 1; d <= 2 && front.length; d++) {
    front = front.flatMap((k) => byKey.get(k)?.consequences.map((c) => c.key) ?? []).filter((k) => byKey.has(k) && !col.has(k));
    for (const k of front) col.set(k, d);
  }
  const rows = new Map<number, number>();
  return [...col].sort((a, b) => a[1] - b[1] || (byKey.get(a[0])!.epFrom ?? 0) - (byKey.get(b[0])!.epFrom ?? 0))
    .map(([key, c]) => { const row = rows.get(c) ?? 0; rows.set(c, row + 1); return { key, col: c, row }; });
}
