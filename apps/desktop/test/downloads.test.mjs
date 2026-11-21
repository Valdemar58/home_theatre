import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent from "webtorrent";
import { Downloads, inspectTorrent } from "../src/downloads.mjs";
import { Library } from "../src/library.mjs";
import { resolveMagnet } from "../src/magnet.mjs";
import { storageSnapshot } from "../src/storage.mjs";

const options = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false };
test("successful preparation clears a persisted import failure without masking an unprepared episode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "download-recovery-"));
  const library = { files: [{ id: "one", state: "ready" }, { id: "two", state: "imported" }] };
  const manager = new Downloads(dir, library, async () => {});
  const job = { id: "job", state: "error", error: "save failed", selected: [{ libraryId: "one", error: "EPERM" }, { libraryId: "two", error: "EPERM" }] };
  manager.jobs = [job];
  try {
    await manager.tick();
    assert.equal(job.state, "error"); assert.equal(job.selected[0].error, undefined); assert.equal(job.selected[1].error, "EPERM");
    library.files[1].state = "ready";
    await manager.tick();
    assert.equal(job.state, "ready"); assert.equal(job.error, undefined); assert(job.selected.every(s => !s.error));
    const persisted = JSON.parse(await readFile(join(dir, "downloads.json"), "utf8"));
    assert.equal(persisted[0].state, "ready");
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});
async function until(fn) { const deadline = Date.now() + 20000; while (!fn()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise(r => setTimeout(r, 30)); } }
for (const source of ["torrent", "magnet"]) test(`${source}: selected episodes download over real localhost BitTorrent, pause/resume, persist and enter preparation only after verification`, { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-download-"));
  const seed = new WebTorrent(options); seed.on("error", () => {});
  let manager;
  try {
    const contents = [randomBytes(450000), randomBytes(450000), randomBytes(450000)];
    const paths = await Promise.all(contents.map(async (b, i) => { const p = join(dir, `Show S01E0${i + 1}.mp4`); await writeFile(p, b); return p; }));
    const torrent = await new Promise((resolve, reject) => { seed.once("error", reject); seed.seed(paths, { name: "Test season", announce: [] }, resolve); });
    const library = new Library(join(dir, "library")); await library.load();
    const prepare = async (lib, id) => { const f = lib.files.find(f => f.id === id); assert.deepEqual(await readFile(f.path), contents[f.ep - 1]); f.state = "ready"; f.progress = 1; };
    manager = new Downloads(join(dir, "state"), library, prepare, options); await manager.load();
    const metadata = await inspectTorrent(torrent.torrentFile); assert.equal(metadata.files.length, 3);
    let descriptor = Buffer.from(torrent.torrentFile);
    if (source === "magnet") {
      let discovery;
      descriptor = await resolveMagnet(torrent.magnetURI, { clientOptions: options, onTorrent: t => { discovery = t; t.once("infoHash", () => t.addPeer(`127.0.0.1:${seed.torrentPort}`)); } });
      assert.equal(discovery.destroyed, true);
      assert.equal(discovery.downloaded, 0);
      assert.equal((await inspectTorrent(descriptor)).hash, metadata.hash);
    }
    const job = await manager.inspect(descriptor.toString("base64"), 42, "Test", "Batch");
    await assert.rejects(manager.start(job.id, [{ index: 0, episode: 1 }, { index: 2, episode: 1 }], join(dir, "target")), /уникальный/);
    await manager.start(job.id, [{ index: 0, episode: 1 }, { index: 2, episode: 3 }], join(dir, "target"));
    await manager.pause(job.id); assert.equal(manager.get(job.id).state, "paused");
    await manager.resume(job.id);
    manager.active.get(job.id).addPeer(`127.0.0.1:${seed.torrentPort}`);
    await until(() => manager.get(job.id).state === "ready");
    assert.deepEqual(library.files.map(f => f.ep).sort(), [1, 3]);
    assert.equal(manager.active.size, 0);
    // The ready state is assigned before the periodic tick finishes persisting it.
    // Wait for that operation before simulating a separate manual retry.
    await manager.operations;
    const failedImport = manager.get(job.id).selected[0];
    delete failedImport.libraryId;
    failedImport.error = "EPERM while saving import";
    manager.get(job.id).state = "error";
    await manager.resume(job.id);
    const retryTorrent = manager.active.get(job.id);
    retryTorrent.addPeer(`127.0.0.1:${seed.torrentPort}`);
    await until(() => manager.get(job.id).state === "ready");
    await manager.operations;
    assert(failedImport.libraryId);
    assert.equal(failedImport.error, undefined);
    assert.equal(library.files.length, 2);
    manager.get(job.id).state = "error";
    manager.get(job.id).error = "Preparation was retried manually";
    await manager.tick();
    assert.equal(manager.get(job.id).state, "ready");
    assert.equal(manager.get(job.id).error, undefined);
    const excluded = manager.snapshot()[0].files[1]; assert.equal(excluded.selected, false);
    await manager.close(); manager = new Downloads(join(dir, "state"), library, prepare, options); await manager.load();
    assert.equal(manager.get(job.id).state, "ready");
    const stored=await storageSnapshot(manager,join(dir,"target"));
    assert.ok(stored.volumes.some(v=>v.total>0 && v.free>=0 && v.titles.some(t=>t.id===42&&t.bytes>0)));
    assert.equal(JSON.stringify(stored).includes(dir),false);
    const removed=library.files.find(f=>f.ep===1), kept=library.files.find(f=>f.ep===3);
    manager.options.isInUse=id=>id===removed.id;
    await assert.rejects(manager.removeEpisode(job.id,0),/транслируется/);
    assert.deepEqual(await readFile(removed.path),contents[0]);
    manager.options.isInUse=()=>false;
    await manager.removeEpisode(job.id,0);await manager.removeEpisode(job.id,0);
    await assert.rejects(readFile(removed.path),{code:"ENOENT"});
    assert.deepEqual(await readFile(kept.path),contents[2]);
    assert.equal(manager.snapshot()[0].files[0].selected,false);
    assert.equal(manager.snapshot()[0].files[2].selected,true);
    await manager.cancel(job.id); await manager.forget(job.id);
    assert.deepEqual(await readFile(library.files[0].path), contents[2]);
    assert.deepEqual(await readFile(paths[0]), contents[0]);
  } finally { await manager?.close(); await new Promise(r => seed.destroy(r)); await rm(dir, { recursive: true, force: true }); }
});

test("invalid metadata is rejected before creating download state", async () => {
  await assert.rejects(inspectTorrent(Buffer.from("not a torrent")));
  await assert.rejects(inspectTorrent(Buffer.alloc(8 * 1024 * 1024 + 1)));
});

test("magnet discovery times out, cancels and rejects non-magnet inputs", async () => {
  const uri = `magnet:?xt=urn:btih:${"a".repeat(40)}`;
  await assert.rejects(resolveMagnet("https://example.com/file"), /magnet/);
  await assert.rejects(resolveMagnet(uri, { clientOptions: options, timeout: 30 }), /Пиры не передали/);
  const controller = new AbortController();
  await assert.rejects(resolveMagnet(uri, { clientOptions: options, signal: controller.signal, onTorrent: () => controller.abort() }), /отменено/);
});

