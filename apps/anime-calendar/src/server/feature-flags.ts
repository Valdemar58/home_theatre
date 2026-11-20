import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Unleash } from "unleash-client";
import type { ClientFeaturesResponse } from "unleash-client/lib/feature";
import { AI_FLAGS, FEATURE_FLAGS, type AiCategory, type AiFlag } from "@/lib/feature-flags";

type Options = { directory: string; url?: string; token?: string; environment?: string; refreshInterval?: number };

function snapshot(value: unknown): value is ClientFeaturesResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as ClientFeaturesResponse;
  return Array.isArray(data.features) && data.features.every((f) =>
    f && typeof f.name === "string" && typeof f.enabled === "boolean" && Array.isArray(f.strategies))
    && (data.segments === undefined || Array.isArray(data.segments));
}

export class AiDisabled extends Error {
  constructor(public category: AiCategory) { super("ИИ временно отключён администратором"); }
}

/** No request waits for the flag service. SDK strategies are evaluated only on the server. */
export class FeatureFlagRuntime {
  private client?: Unleash;
  private configured: boolean;
  private storageError = false;
  private lastSync: number | null = null;
  private cacheLoaded = false;
  private ready = false;
  readonly overridesFile: string;

  constructor(private options: Options) {
    this.configured = Boolean(options.url || options.token);
    this.overridesFile = path.join(options.directory, "overrides.json");
    if (!options.url || !options.token) return;
    try {
      const url = new URL(options.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    } catch { return; }
    // A cache for another server/environment/token scope must never enable features here.
    const scope = createHash("sha256").update(JSON.stringify([
      options.url, options.environment || "production", options.token,
    ])).digest("hex");
    const file = path.join(options.directory, `snapshot-${scope}.json`);
    let cached: ClientFeaturesResponse | undefined;
    try {
      const envelope = JSON.parse(readFileSync(file, "utf8"));
      if (envelope.scope === scope && snapshot(envelope.data)) cached = envelope.data;
    } catch { /* No valid snapshot: managed AI stays disabled until synchronization. */ }
    this.cacheLoaded = Boolean(cached);
    // The SDK ignores empty bootstraps. Empty is still a valid, fail-closed snapshot.
    this.ready = Boolean(cached && cached.features.length === 0);
    this.client = new Unleash({
      url: options.url, appName: "home-theater", environment: options.environment || "production",
      customHeaders: { Authorization: options.token }, disableAutoStart: true,
      disableMetrics: true, timeout: 2500, refreshInterval: options.refreshInterval ?? 5000,
      // Bootstrap also preserves a valid empty snapshot: deleted flags must remain disabled.
      bootstrap: cached ? { data: cached.features, segments: cached.segments } : undefined,
      storageProvider: {
        get: async () => cached,
        set: async (_key, data) => {
          if (!snapshot(data)) throw new Error("Invalid feature flag snapshot");
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            mkdirSync(options.directory, { recursive: true, mode: 0o700 });
            writeFileSync(temporary, JSON.stringify({ scope, data }), { mode: 0o600, flag: "wx" });
            renameSync(temporary, file);
            this.storageError = false;
          } catch {
            this.storageError = true;
            try { unlinkSync(temporary); } catch { /* Already renamed or never written. */ }
          }
        },
      },
    });
    // SDK errors can contain credentials/addresses. Diagnostics expose state, never raw errors.
    this.client.on("error", () => {});
    this.client.on("warn", () => {});
    this.client.on("ready", () => { this.ready = true; });
    this.client.on("synchronized", () => { this.lastSync = Date.now(); });
    void this.client.start().catch(() => {});
  }

  private forcedOff(): Set<string> | null {
    const off = new Set((process.env.FEATURE_FLAGS_FORCE_OFF || "").split(",").map((s) => s.trim()).filter(Boolean));
    try {
      const data = JSON.parse(readFileSync(this.overridesFile, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.disabled) || data.disabled.some((s: unknown) =>
        typeof s !== "string" || !FEATURE_FLAGS.includes(s as AiFlag))) return null;
      for (const name of data.disabled) off.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    return off;
  }

  enabled(flag: AiFlag): boolean {
    if (!FEATURE_FLAGS.includes(flag)) return false;
    const overrides = this.forcedOff();
    if (!overrides || overrides.has(AI_FLAGS.all) || overrides.has(flag)) return false;
    if (!this.configured) return true;
    return this.ready && Boolean(this.client?.isEnabled(flag, {}, false));
  }

  allowed(category: AiCategory): boolean { return this.enabled(AI_FLAGS.all) && this.enabled(AI_FLAGS[category]); }
  assert(category: AiCategory): void { if (!this.allowed(category)) throw new AiDisabled(category); }
  status() {
    return { configured: this.configured, ready: this.ready, cacheLoaded: this.cacheLoaded,
      lastSync: this.lastSync, storageError: this.storageError,
      localOverrideValid: this.forcedOff() !== null,
      flags: Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag, this.enabled(flag)])) };
  }
  destroy() { this.client?.destroy(); }
}

const globalFlags = globalThis as typeof globalThis & { homeTheaterFlags?: FeatureFlagRuntime };
export function featureFlags(): FeatureFlagRuntime {
  return globalFlags.homeTheaterFlags ??= new FeatureFlagRuntime({
    directory: path.join(process.env.DATA_DIR || "./data", "feature-flags"),
    url: process.env.UNLEASH_URL, token: process.env.UNLEASH_API_TOKEN,
    environment: process.env.UNLEASH_ENVIRONMENT,
  });
}
