import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMedia, HostTransport } from "../src/transport.mjs";
test("host signalling uses the configured network stack with bearer authentication, no session cookies and no redirects",async()=>{
  const transport=new HostTransport({files:[]},()=>({server:"https://fixture.invalid",token:"device-token"}),async(url,options)=>{
    assert.equal(url,"https://fixture.invalid/api/desktop/transport");
    assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");
    assert.equal(options.headers.Authorization,"Bearer device-token");
    assert.equal(options.headers["X-Desktop-Protocol"],"2");
    return Response.json({streams:[{id:"lease"}],jobs:[]});
  });
  await transport.poll();assert.deepEqual(transport.list(),[{id:"lease"}]);transport.stop();
});
test("protocol mismatch revokes streams, preserves binding and exposes an actionable error; recovery clears it", async () => {
  const originalFetch = globalThis.fetch;
  const credentials = { server: "https://fixture.invalid", token: "fixture" };
  const transport = new HostTransport({ files: [] }, () => credentials);
  let incompatible = true;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers["X-Desktop-Protocol"], "2");
    return incompatible
      ? Response.json({ error: "Обновите desktop" }, { status: 426 })
      : Response.json({ streams: [{ id: "new" }], jobs: [] });
  };
  try {
    transport.streams = [{ id: "old" }]; transport.seen = Date.now();
    await transport.poll();
    assert.deepEqual(transport.list(), []);
    assert.equal(transport.error, "Обновите desktop");
    assert.equal(credentials.token, "fixture");
    incompatible = false;
    await transport.poll();
    assert.deepEqual(transport.list(), [{ id: "new" }]);
    assert.equal(transport.error, "");
  } finally { transport.stop(); globalThis.fetch = originalFetch; }
});
test("transport serves bounded ranges only from the authorized unchanged prepared file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-range-"));
  try {
    const path = join(dir, "source"), output = join(dir, "prepared"); await writeFile(path, "source"); await writeFile(output, "01234567");
    const f = { id: "f", path, output, bytes: 6, mtime: (await stat(path)).mtimeMs, state: "ready", preparedVersion: "version", preparedBytes: 8, preparedMtime: (await stat(output)).mtimeMs };
    const library = { files: [f] }, stream = { file: "f", version: "version", bytes: 8 };
    assert.equal((await readMedia(library, stream, 2, 3)).toString(), "234");
    await assert.rejects(readMedia(library, { ...stream, file: "../../secret" }, 0, 1));
    await assert.rejects(readMedia(library, stream, 0, 9));
    await assert.rejects(readMedia(library, { ...stream, version: "other" }, 0, 1));
    await writeFile(output, "changed output"); await assert.rejects(readMedia(library, stream, 0, 1));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
