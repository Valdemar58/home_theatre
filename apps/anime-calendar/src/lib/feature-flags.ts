/** Operational switches are permanent. Experiments need their own removal issue. */
export const AI_FLAGS = {
  all: "ai-enabled",
  shared: "ai-shared",
  personal: "ai-personal",
  media: "ai-media",
} as const;
export type AiCategory = "shared" | "personal" | "media";
export type AiFlag = (typeof AI_FLAGS)[keyof typeof AI_FLAGS];
export const FEATURE_FLAGS = Object.values(AI_FLAGS);

export type FlagDefinition = { name: string; owner: string; standaloneDefault: boolean; managedDefault: boolean } & (
  { kind: "operational"; lifetime: "permanent" } |
  { kind: "experiment"; scope: "session"; removalIssue: number; reviewRelease: string }
);

export const FLAG_REGISTRY: FlagDefinition[] = FEATURE_FLAGS.map((name) => ({
  name, kind: "operational" as const, owner: "server", lifetime: "permanent" as const,
  // Preserve configured AI when the optional flag service has never been connected.
  standaloneDefault: true, managedDefault: false,
}));
