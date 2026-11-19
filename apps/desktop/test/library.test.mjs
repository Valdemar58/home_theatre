import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { Library } from "../src/library.mjs";
import { prepare } from "../src/prepare.mjs";

test("library persists entries, detects changed sources and never deletes originals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-library-"));
  try {
    const source = join(dir, "source.mkv");
    await writeFile(source, "some video");
    const library = new Library(join(dir, "data"));
    await library.load();
    const f = await library.add(source, 42, 1);
    const restored = new Library(join(dir, "data"));
    await restored.load();
    assert.equal(restored.files[0].version, f.version);
    assert.equal(
      JSON.stringify(restored.publicFiles()).includes(source),
      false,
    );
    await writeFile(source, "changed video");
    await restored.refresh();
    assert.equal(restored.files[0].state, "error");
    await restored.remove(f.id);
    assert.equal(await readFile(source, "utf8"), "changed video");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real FFmpeg preparation produces a persisted playable derivative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-prepare-"));
  try {
    const source = join(dir, "source.mkv");
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=24",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ],
      { windowsHide: true },
    );
    const library = new Library(join(dir, "data"));
    await library.load();
    const f = await library.add(source, 42, 1);
    f.state = "error";
    f.error = "Previous transcode was interrupted";
    await prepare(library, f.id);
    assert.equal(f.state, "ready");
    assert.equal(f.progress, 1);
    assert.ok((await stat(f.output)).size > 0);
    const restored = new Library(join(dir, "data"));
    await restored.load();
    assert.equal(restored.files[0].state, "ready");
    execFileSync(ffmpeg, ["-v", "error", "-i", f.output, "-f", "null", "-"], {
      windowsHide: true,
    });
    const output = f.output;
    await restored.remove(f.id);
    await assert.rejects(stat(output));
    assert.ok((await stat(source)).size > 0);
    await writeFile(source, "changed");
    await assert.rejects(prepare(library, f.id), /изменён/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
