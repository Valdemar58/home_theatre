import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rename, unlink, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../src/atomic-file.mjs";

for (const code of ["EPERM", "EACCES", "EBUSY"]) test(`atomic state survives transient ${code} without deleting the old file`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-state-")), file = join(directory, "state.json");
  let attempts = 0;
  try {
    await writeFile(file, '{"old":true}');
    await atomicWrite(file, '{"new":true}', { writeFile, unlink, delay: async () => {}, rename: async (source, destination) => {
      attempts++;
      if (attempts < 3) {
        assert.equal(await readFile(destination, "utf8"), '{"old":true}');
        throw Object.assign(new Error("locked"), { code });
      }
      return rename(source, destination);
    } });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { new: true });
    assert.deepEqual(await readdir(directory), ["state.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const code of ["EPERM", "ENOSPC"]) test(`permanent ${code} preserves last good state and cleans its temporary file`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-state-")), file = join(directory, "state.json");
  let attempts = 0;
  try {
    await writeFile(file, '{"old":true}');
    await assert.rejects(atomicWrite(file, "new", { writeFile, unlink, delay: async () => {}, rename: async () => {
      attempts++; throw Object.assign(new Error("persistent failure"), { code });
    } }), { code });
    assert.equal(attempts, code === "EPERM" ? 6 : 1);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { old: true });
    assert.deepEqual(await readdir(directory), ["state.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
