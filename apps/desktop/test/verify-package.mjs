// Compare shipped application sources to this checkout; no UI or profile changes.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {updateFeed} from "../src/updates.mjs";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { extractFile } = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const yaml=createRequire(require.resolve("electron-updater"))("js-yaml");
for (const archive of process.argv.slice(2)) {
  for (const file of ["device-identity.mjs", "main.mjs", "chrome-preload.cjs", "storage.mjs", "library.mjs", "remote-downloads.mjs", "downloads.mjs", "magnet.mjs", "prepare.mjs", "renderer.js", "style.css", "index.html", "profiles.mjs", "product.mjs", "onboarding.html", "onboarding.css", "onboarding.js", "server-picker.js", "rtc.html", "preload.cjs", "embedded-view.mjs", "loading.html", "loading.css", "loading.js", "onboarding-endpoints.mjs", "updates.mjs", "electron-updates.mjs"]) {
    assert.deepEqual(extractFile(resolve(archive), `src/${file}`), await readFile(new URL(`../src/${file}`,import.meta.url)), `${archive}: ${file}`);
  }
  assert.equal(JSON.parse(extractFile(resolve(archive),"package.json")).version,JSON.parse(await readFile(new URL("../package.json",import.meta.url))).version);
  assert.deepEqual(extractFile(resolve(archive),"src/compatibility.mjs"),await readFile(new URL("../src/compatibility.mjs",import.meta.url)));
  const update=yaml.load(await readFile(resolve(archive,"..","app-update.yml"),"utf8"));
  assert.equal(update.provider,"generic");assert.equal(update.url,updateFeed);
  console.log(`Verified current sources and version: ${archive}`);
}


