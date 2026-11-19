import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./stream", () => ({ jellyfin: vi.fn() }));
vi.mock("./route", () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const { jellyfin } = await import("./stream");
const { jellyfinPlaybackUser } = await import("./jellyfin-playback-user");
const request = vi.mocked(jellyfin);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("keeps an existing linked media user when it can access the episode", async () => {
  request.mockResolvedValueOnce({ Id: "episode" });
  expect(await jellyfinPlaybackUser("linked-user", "episode")).toBe(
    "linked-user",
  );
  expect(request).toHaveBeenCalledTimes(1);
});
it("a local account uses the media backend's enabled technical user without a Jellyfin login", async () => {
  request.mockResolvedValueOnce([
    { Id: "disabled", Policy: { IsAdministrator: true, IsDisabled: true } },
    { Id: "media-admin", Policy: { IsAdministrator: true } },
  ]);
  expect(await jellyfinPlaybackUser("local:account", "episode")).toBe(
    "media-admin",
  );
  expect(request).toHaveBeenCalledWith("/Users");
  expect(request).toHaveBeenCalledTimes(1);
});
it("a removed legacy identity falls back independently of application admin roles", async () => {
  request
    .mockRejectedValueOnce(new Error("HTTP 404"))
    .mockResolvedValueOnce([
      { Id: "media-admin", Policy: { IsAdministrator: true } },
    ]);
  expect(await jellyfinPlaybackUser("removed-legacy-user", "episode")).toBe(
    "media-admin",
  );
});
it("an explicit technical identity is honored and missing configuration fails clearly", async () => {
  vi.stubEnv("JELLYFIN_PLAYBACK_USER_ID", "technical");
  request.mockResolvedValue([{ Id: "technical", Policy: {} }]);
  expect(await jellyfinPlaybackUser("local:account", "episode")).toBe(
    "technical",
  );
  request.mockResolvedValue([]);
  await expect(
    jellyfinPlaybackUser("local:account", "episode"),
  ).rejects.toMatchObject({ status: 503 });
});
