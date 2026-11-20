// Compare shipped application sources to this checkout; no UI or profile changes.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { extractFile } = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
for (const archive of process.argv.slice(2)) {
  for (const file of ["device-identity.mjs", "main.mjs", "chrome-preload.cjs", "storage.mjs", "library.mjs", "remote-downloads.mjs", "downloads.mjs", "magnet.mjs", "prepare.mjs", "renderer.js", "style.css", "index.html", "profiles.mjs", "product.mjs", "onboarding.html", "onboarding.css", "onboarding.js", "server-picker.js", "rtc.html"]) {
    assert.deepEqual(extractFile(resolve(archive), `src/${file}`), await readFile(new URL(`../src/${file}`,import.meta.url)), `${archive}: ${file}`);
  }
  assert.equal(JSON.parse(extractFile(resolve(archive),"package.json")).version,JSON.parse(await readFile(new URL("../package.json",import.meta.url))).version);
  console.log(`Verified current sources and version: ${archive}`);
}


