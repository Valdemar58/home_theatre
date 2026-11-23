/** Bounded troubleshooting data; never retain arbitrary browser objects, SDP or addresses. */
export function playbackTelemetry(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.client !== "safari" && input.client !== "other") return null;
  const clean = (raw: unknown, numeric: Record<string, number>, flags: string[], enums: Record<string, string[]> = {}) => {
    const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const out: Record<string, number | boolean | string> = {};
    for (const [key, max] of Object.entries(numeric)) { const v = source[key]; if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max) out[key] = v; }
    for (const key of flags) if (typeof source[key] === "boolean") out[key] = source[key] as boolean;
    for (const [key, choices] of Object.entries(enums)) if (typeof source[key] === "string" && choices.includes(source[key])) out[key] = source[key];
    return out;
  };
  return {
    client: input.client,
    element: clean(input.element, { currentTime: 86400, bufferedAhead: 86400, readyState: 4, networkState: 3, playbackRate: 4, volume: 1, errorCode: 4, decodedFrames: 1e12 }, ["paused", "ended", "seeking", "muted", "autoplayBlocked"]),
    transport: clean(input.transport, { packets: 1e12, directBytes: 1e15, relayBytes: 1e15 }, [], { mode: ["connecting", "direct", "relay", "recovering", "closed"], ice: ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"], channel: ["connecting", "open", "closing", "closed"] }),
  };
}
