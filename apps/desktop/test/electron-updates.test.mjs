import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {ElectronUpdates} from "../src/electron-updates.mjs";

test("real updater adapter enables verified differential updates without enabling web installers or downgrades",async()=>{
  const engine=new EventEmitter();
  const adapter=new ElectronUpdates(engine);
  await adapter.configure("preview");
  assert.equal(engine.disableDifferentialDownload,false);
  assert.equal(engine.disableWebInstaller,true);
  assert.equal(engine.autoDownload,false);
  assert.equal(engine.autoInstallOnAppQuit,false);
  assert.equal(engine.allowDowngrade,false);
  assert.equal(engine.channel,"preview");
});
