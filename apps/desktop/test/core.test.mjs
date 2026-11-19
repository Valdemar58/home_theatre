import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { serverUrl } from "../src/server-url.mjs";
import { identifyFile } from "../src/file-identity.mjs";

test("server origin rejects insecure remote URLs, credentials and payloads", () => {
  assert.equal(serverUrl("https://cinema.example"), "https://cinema.example");
  for (const url of [
    "http://cinema.example",
    "http://127.0.0.1",
    "file:///tmp/x",
    "https://a:b@cinema.example",
    "https://cinema.example/a",
    "https://cinema.example/?token=x",
  ]) {
    assert.throws(() => serverUrl(url));
  }
  assert.equal(
    serverUrl("http://127.0.0.1:5056", { development: true }),
    "http://127.0.0.1:5056",
  );
  assert.throws(() =>
    serverUrl("http://localhost.evil", { development: true }),
  );
});

test("identity survives rename but differentiates equal-size copies; no local path leaks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "home-theater-identity-"));
  try {
    const a = join(dir, "a.mkv"),
      b = join(dir, "b.mkv");
    await writeFile(a, "version one");
    const identity = await identifyFile(a);
    await rename(a, b);
    assert.deepEqual(await identifyFile(b), identity);
    await writeFile(a, "version two");
    assert.notEqual((await identifyFile(a)).version, identity.version);
    assert.deepEqual(Object.keys(identity).sort(), ["bytes", "version"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity rejects empty files and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "home-theater-identity-"));
  try {
    const path = join(dir, "a.mkv");
    await writeFile(path, "");
    await assert.rejects(identifyFile(path), /непустой/);
    await writeFile(path, "video");
    await assert.rejects(identifyFile(path, { signal: AbortSignal.abort() }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file changing during hashing cannot become a ready version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "home-theater-identity-"));
  try {
    const path = join(dir, "a.mkv");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024));
    let changed = false;
    await assert.rejects(
      identifyFile(path, {
        onProgress() {
          if (!changed) {
            changed = true;
            appendFileSync(path, "changed");
          }
        },
      }),
      /изменился/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
