import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteDownloads } from "../src/remote-downloads.mjs";

test("lost acknowledgement and process restart do not start a download twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remote-downloads-"));
  let starts = 0, fail = true;
  const command = { id: "stable-command", kind: "start", payload: { job: "job", selections: [{ index: 0, episode: 1 }] } };
  const job = { id: "job", state: "selecting" };
  const downloads = { jobs:[],library:{files:[],directory:dir},options:{},snapshot: () => [], get: () => job, start: async () => { starts++; job.state = "downloading"; } };
  const request = async body => {
    if (body.receipt && fail) { fail = false; throw new Error("Connection lost"); }
    return { commands: [command] };
  };
  try {
    const first = new RemoteDownloads(downloads, request, join(dir, "receipts.json"), () => dir); await first.load();
    await assert.rejects(first.tick(), /Connection lost/);
    const restarted = new RemoteDownloads(downloads, request, join(dir, "receipts.json"), () => dir); await restarted.load(); await restarted.tick();
    assert.equal(starts, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("offline episode selection refuses ambiguous file mappings instead of downloading arbitrary files", async () => {
  let starts = 0;
  const job = { id: "job", state: "selecting", files: [{ index: 0, video: true, episode: 1 }, { index: 1, video: true, episode: 1 }] };
  const d = { inspect: async () => job, get: () => job, start: async () => starts++ };
  const worker = new RemoteDownloads(d, null, "unused", () => "unused");
  await assert.rejects(worker.execute({ id: "command", kind: "inspect", payload: { episodes: [1], torrent: "fixture", title: 42 } }), /уточнить/);
  assert.equal(starts, 0);
});

