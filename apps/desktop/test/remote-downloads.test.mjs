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

test("episode preparation cannot replace an active stream and repeated completed commands are harmless",async()=>{
  let calls=0;
  const file={id:"file",state:"error",inUse:true};
  const d={library:{files:[file]},checkRemoval:f=>{if(f.inUse)throw new Error("in use");},prepare:async()=>{calls++;file.state="ready";}};
  const worker=new RemoteDownloads(d,null,"unused",()=>"unused");
  const command={kind:"prepare-episode",payload:{library:"file"}};
  await assert.rejects(worker.execute(command),/in use/);
  file.inUse=false;await worker.execute(command);await worker.execute(command);
  assert.equal(calls,1);assert.equal(d.preparing,false);
});

test("a long-running command still reports progress without executing a second command",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-progress-"));
  let finish,started,requests=0;
  const begun=new Promise(r=>started=r),gate=new Promise(r=>finish=r);
  const d={jobs:[],library:{files:[],directory:dir},options:{},snapshot:()=>[]};
  const command={id:"storage",kind:"storage-add",payload:{}};
  const worker=new RemoteDownloads(d,async()=>{requests++;return {commands:[command]};},join(dir,"receipts"),()=>dir,{addLocation:async()=>{started();await gate;return {cancelled:true};}});
  try{const active=worker.tick();await begun;await worker.tick();assert.equal(requests,2);finish();await active;}finally{finish?.();await rm(dir,{recursive:true,force:true});}
});

