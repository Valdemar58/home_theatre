import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GROUP_PERMISSIONS } from "@/lib/group-policy";

vi.mock("server-only", () => ({}));
vi.mock("./notifications", () => ({ notify: vi.fn(), resolveActions: vi.fn() }));
vi.mock("./social", () => ({ areFriends: () => true, friendIds: () => [] }));
vi.mock("./lists", () => ({
  ensureMedia: async (id: number) => ({ id }),
  getMedia: (id: number) => ({ id, title: { romaji: `Title ${id}` }, status: "FINISHED", duration: 24, episodes: 12, coverImage: { large: null } }),
}));
vi.mock("./playback", () => ({ episodeItems: vi.fn() }));
vi.mock("./rooms", () => ({ createRoom: vi.fn(), roomEnded: vi.fn() }));
vi.mock("./stream-voices", () => ({ setVoicePref: vi.fn(), voicePref: vi.fn() }));
vi.mock("./tasks", () => ({ startTask: vi.fn() }));
process.env.DATABASE_DRIVER = process.env.POSTGRES_TEST === "1" ? "postgres" : "sqlite";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "group-planning-"));
const { db } = await import("./db");
const { createList, addItem, listDetail, inviteToList, removeItem } = await import("./together");
const { groupAction, groupPlan, groupTick } = await import("./groups");
const { episodeItems } = await import("./playback");
const { startTask } = await import("./tasks");
const owner = { id: 1, name: "organizer" }, member = { id: 2, name: "viewer" };
let id: number;

beforeEach(() => {
  db.exec("DELETE FROM shared_lists; DELETE FROM users;");
  for (const u of [owner, member, { id: 3, name: "guest" }]) db.prepare("INSERT INTO users (id, jellyfin_id, name, created_at) VALUES (?, ?, ?, 0)").run(u.id, String(u.id), u.name);
  id = createList(owner, "Room", []);
  db.prepare("INSERT INTO shared_list_members (list_id,user_id,status,joined_at) VALUES (?,2,'member',0)").run(id);
});

describe("room planning: real storage and authorization", () => {
  it("stores one validated sync policy for the room and restricts changes to its organizer", () => {
    const policy = { tolerance:0.3, hardSeek:8, maxRate:1.15, minRate:0.95, settleSeconds:6, curve:"linear" };
    expect(groupAction(owner,id,{action:"sync-policy",policy}).syncPolicy).toEqual(policy);
    expect(groupPlan(member.id,id).syncPolicy).toEqual(policy);
    expect(()=>groupAction(member,id,{action:"sync-policy",policy})).toThrow(/организатор/);
    expect(()=>groupAction(owner,id,{action:"sync-policy",policy:{...policy,maxRate:3}})).toThrow();
  });
  it("prepares every selected episode of every title, without filling gaps", async () => {
    await addItem(owner, id, 10); await addItem(owner, id, 11);
    vi.mocked(episodeItems).mockResolvedValue(new Map([1, 2, 3].map(ep => [ep, [{ itemId: `test-${ep}`, where: "stream", hash: "test", index: ep }]])) as Awaited<ReturnType<typeof episodeItems>>);
    vi.mocked(startTask).mockClear(); vi.mocked(episodeItems).mockClear();
    groupAction(owner, id, { action: "session-save", startsAt: Math.floor(Date.now() / 1000) + 1800, plan: { timeZone: "UTC", skipCredits: false, blocks: [10, 11].map(anilistId => ({ anilistId, episodes: [1, 3], breakMinutes: 10, durationMinutes: 24, durationSource: "catalog" })) } });
    await groupTick();
    expect(vi.mocked(episodeItems).mock.calls.map(c => c[0])).toEqual([10, 11]);
    expect(vi.mocked(startTask).mock.calls.map(c => c[1])).not.toContain("test:2");
    expect(vi.mocked(startTask).mock.calls).toHaveLength(8);
  });
  it("persists non-contiguous multi-title plans, rejects stale writes, and preserves RSVP", async () => {
    await addItem(owner, id, 10); await addItem(owner, id, 11);
    const startsAt = Math.floor(Date.now() / 1000) + 86400;
    const plan = { blocks: [10, 11].map(anilistId => ({ anilistId, episodes: [1, 3, 5], breakMinutes: 15, durationMinutes: 999, durationSource: "estimate" as const })), skipCredits: true, timeZone: "Europe/Berlin" };
    const created = groupAction(owner, id, { action: "session-save", startsAt, plan }).sessions[0];
    expect(created.plan!.blocks.map(b => b.episodes)).toEqual([[1, 3, 5], [1, 3, 5]]);
    expect(created.plan!.blocks[0].durationMinutes).toBe(24);
    expect(() => groupAction(member, id, { action: "session-save", sessionId: created.id, revision: 1, startsAt, plan })).toThrow(/Нет права/);
    const updated = groupAction(owner, id, { action: "session-save", sessionId: created.id, revision: 1, startsAt, plan: { ...plan, blocks: [...plan.blocks].reverse() } }).sessions[0];
    expect(updated.revision).toBe(2); expect(updated.anilistId).toBe(11); expect(updated.rsvp).toEqual(created.rsvp);
    expect(() => groupAction(owner, id, { action: "session-save", sessionId: created.id, revision: 1, startsAt, plan })).toThrow(/уже изменён/);
    db.prepare("UPDATE group_sessions SET status = 'live' WHERE id = ?").run(created.id);
    expect(() => groupAction(owner, id, { action: "session-save", sessionId: created.id, revision: 2, startsAt, plan })).toThrow(/нельзя редактировать/);
  });
  it("rejects invalid plans atomically and adapts legacy rows", async () => {
    await addItem(owner, id, 10);
    const startsAt = Math.floor(Date.now() / 1000) + 86400;
    const block = { anilistId: 10, episodes: [1, 3], breakMinutes: 10, durationMinutes: 24, durationSource: "catalog" as const };
    for (const blocks of [[], [block, block], [{ ...block, episodes: [] }], [{ ...block, episodes: [13] }], [{ ...block, breakMinutes: -1 }], [block, { ...block, anilistId: 99 }]]) {
      expect(() => groupAction(owner, id, { action: "session-save", startsAt, plan: { blocks, timeZone: "UTC", skipCredits: false } })).toThrow();
      expect(groupPlan(1, id).sessions).toHaveLength(0); expect(groupPlan(1, id).queue).toHaveLength(0);
    }
    const legacy = groupAction(owner, id, { action: "session-create", anilistId: 10, ep: 3, count: 2, startsAt }).sessions[0];
    expect(legacy.plan!.blocks[0].episodes).toEqual([3, 4]);
  });
  it("rejects sessions outside the known season without changing the queue", async () => {
    await addItem(owner, id, 10);
    const startsAt = Math.floor(Date.now() / 1000) + 3600;
    expect(() => groupAction(owner, id, { action: "session-create", anilistId: 10, ep: 13, count: 1, startsAt })).toThrow(/12 серий/);
    expect(() => groupAction(owner, id, { action: "session-create", anilistId: 10, ep: 12, count: 2, startsAt })).toThrow(/12 серий/);
    expect(groupPlan(1, id).sessions).toHaveLength(0);
    expect(groupPlan(1, id).queue).toHaveLength(0);
    expect(groupAction(owner, id, { action: "session-create", anilistId: 10, ep: 12, count: 1, startsAt }).sessions).toHaveLength(1);
  });
  it("keeps proposals separate from personal progress and retries do not duplicate items", async () => {
    await addItem(member, id, 10); await addItem(member, id, 10);
    expect(listDetail(2, id).items).toHaveLength(1);
    expect(listDetail(2, id).items[0].state).toBe("proposed");
    expect(db.prepare("SELECT * FROM list_entries").all()).toHaveLength(0);
    expect(() => groupAction(member, id, { action: "queue-add", anilistId: 10 })).toThrow(/недоступно/);
    groupAction(owner, id, { action: "queue-add", anilistId: 10 });
    groupAction(owner, id, { action: "queue-add", anilistId: 10 });
    expect(groupPlan(2, id).queue).toHaveLength(1);
    expect(listDetail(2, id).items[0].planningState).toBe("accepted");
  });
  it("enforces permissions across legacy endpoints, then applies organizer grants", async () => {
    await addItem(member, id, 10);
    expect(() => inviteToList(member, id, 3)).toThrow(/недоступно/);
    expect(() => removeItem(2, id, 10)).toThrow(/недоступно/);
    expect(() => groupAction(member, id, { action: "permissions", permissions: DEFAULT_GROUP_PERMISSIONS })).toThrow(/организатор/);
    groupAction(owner, id, { action: "permissions", permissions: { ...DEFAULT_GROUP_PERMISSIONS, queue: "all", invite: "all" } });
    groupAction(member, id, { action: "queue-add", anilistId: 10 });
    inviteToList(member, id, 3);
    expect(() => groupAction({ id: 3, name: "guest" }, id, { action: "queue-add", anilistId: 10 })).toThrow();
    groupAction(owner, id, { action: "permissions", permissions: { ...DEFAULT_GROUP_PERMISSIONS, suggest: "owner" } });
    await expect(addItem(member, id, 11)).rejects.toThrow(/недоступно/);
  });
  it("only the organizer starts polls; winner becomes accepted and queued", async () => {
    await addItem(member, id, 10); await addItem(member, id, 11);
    expect(() => groupAction(member, id, { action: "poll-create", options: [10, 11], hours: 1 })).toThrow(/организатор/);
    const poll = groupAction(owner, id, { action: "poll-create", options: [10, 11], hours: 1 }).poll!;
    groupAction(member, id, { action: "vote", pollId: poll.id, anilistId: 11 });
    expect(() => groupAction(member, id, { action: "poll-close", pollId: poll.id })).toThrow(/организатор/);
    groupAction(owner, id, { action: "poll-close", pollId: poll.id });
    expect(groupPlan(2, id).queue.map(q => q.anilistId)).toEqual([11]);
    expect(listDetail(2, id).items.find(i => i.media.id === 10)?.state).toBe("proposed");
  });
  it("preserves old rows and preset grants until explicit permissions are saved", () => {
    db.prepare("UPDATE shared_lists SET permissions = NULL, preset = 'host' WHERE id = ?").run(id);
    db.prepare("UPDATE shared_list_members SET control = 1 WHERE list_id = ? AND user_id = 2").run(id);
    db.prepare("INSERT INTO shared_list_items (list_id,anilist_id,added_by,added_at) VALUES (?,10,1,0)").run(id);
    expect(listDetail(2, id).items[0].planningState).toBe("accepted");
    expect(groupPlan(2, id).canPlan).toBe(true);
    groupAction(owner, id, { action: "permissions", permissions: DEFAULT_GROUP_PERMISSIONS });
    expect(groupPlan(2, id).canPlan).toBe(false);
  });
  it("scheduling and cancellation work independently of queue promotion", async () => {
    await addItem(member, id, 10); await addItem(member, id, 11);
    groupAction(owner, id, { action: "queue-add", anilistId: 10 });
    groupAction(owner, id, { action: "permissions", permissions: { ...DEFAULT_GROUP_PERMISSIONS, schedule: "all" } });
    const startsAt = Math.floor(Date.now() / 1000) + 3600;
    const plan = groupAction(owner, id, { action: "session-create", anilistId: 10, ep: 1, count: 2, startsAt });
    groupAction(member, id, { action: "session-cancel", sessionId: plan.sessions[0].id });
    groupAction(member, id, { action: "session-create", anilistId: 10, ep: 1, count: 2, startsAt });
    expect(() => groupAction(member, id, { action: "session-create", anilistId: 11, ep: 1, count: 2, startsAt })).toThrow(/недоступно/);
  });
});

