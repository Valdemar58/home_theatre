export type SyncPolicy = { tolerance: number; hardSeek: number; maxRate: number; minRate: number; settleSeconds: number; curve: "linear" | "smooth" };
export const DEFAULT_SYNC_POLICY: SyncPolicy = { tolerance: 0.25, hardSeek: 5, maxRate: 1.12, minRate: 0.97, settleSeconds: 4, curve: "smooth" };
export function syncPolicy(value: unknown): SyncPolicy {
  const p = { ...DEFAULT_SYNC_POLICY, ...(value && typeof value === "object" ? value : {}) } as SyncPolicy;
  for (const [key, min, max] of [["tolerance", 0.05, 2], ["hardSeek", 1, 30], ["maxRate", 1, 1.25], ["minRate", 0.85, 1], ["settleSeconds", 1, 60]] as const) {
    if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < min || p[key] > max) throw Error(`Неверное значение ${key}: от ${min} до ${max}`);
  }
  if (p.hardSeek <= p.tolerance || !["linear", "smooth"].includes(p.curve)) throw Error("Проверьте пороги и кривую синхронизации");
  return Object.fromEntries(Object.keys(DEFAULT_SYNC_POLICY).map(k => [k, p[k as keyof SyncPolicy]])) as SyncPolicy;
}
export function syncCorrection(drift: number, playing: boolean, policy = DEFAULT_SYNC_POLICY) {
  const a = Math.abs(drift);
  if (!Number.isFinite(a)) return { seek: false, rate: 1 };
  if (!playing) return { seek: a > policy.tolerance, rate: 1 };
  if (a > policy.hardSeek) return { seek: true, rate: 1 };
  const excess = Math.max(0, a - policy.tolerance), limit = drift < 0 ? policy.maxRate - 1 : 1 - policy.minRate;
  const delta = limit <= 0 ? 0 : policy.curve === "linear" ? Math.min(limit, excess / policy.settleSeconds) : limit * (1 - Math.exp(-excess / (policy.settleSeconds * limit)));
  return { seek: false, rate: Math.round((1 + (drift < 0 ? delta : -delta)) * 1000) / 1000 };
}
