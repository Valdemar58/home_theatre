/** Media-time intervals, independent of the resume position. Never subtract OP/ED. */
export type WatchedInterval = [number, number];

export function mergeCoverage(input: unknown, duration: number): WatchedInterval[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(input)) return [];
  const ranges = input.filter((r): r is WatchedInterval => Array.isArray(r) && r.length === 2 &&
    r.every((n) => typeof n === "number" && Number.isFinite(n)))
    .map(([a, b]): WatchedInterval => [Math.max(0, a), Math.min(duration, b)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const merged: WatchedInterval[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

export function coverageSeconds(ranges: WatchedInterval[]) {
  return ranges.reduce((sum, [a, b]) => sum + b - a, 0);
}

export function coverageState(input: unknown, duration: number) {
  const intervals = mergeCoverage(input, duration);
  const seconds = coverageSeconds(intervals);
  return { intervals, seconds, started: duration > 0 && seconds >= duration * 0.1,
    watched: duration > 0 && seconds >= duration * 0.8 };
}
