import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,stat,rm,access,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Library } from "../src/library.mjs";
import { StorageLocations } from "../src/storage-locations.mjs";

async function fixture() {
  const dir=await mkdtemp(path.join(tmpdir(),"storage-move-")),source=path.join(dir,"disk-a");
  const targetBase=process.env.HOME_THEATER_TEST_TARGET;
  const target=targetBase?path.join(path.resolve(targetBase),`storage-move-${randomUUID()}`):path.join(dir,"disk-b");
  if(targetBase)await mkdir(path.resolve(targetBase),{recursive:true});
  await mkdir(source);await mkdir(target);
  const library=new Library(path.join(dir,"library"));await library.load();
  const id=randomUUID(),folder=path.join(source,id);await mkdir(folder);
  const selected=[],files=[];
  for(let i=0;i<2;i++) {
    const name=`episode-${i+1}.mp4`,file=path.join(folder,name);await writeFile(file,`original episode ${i+1}`);
    const lib=await library.add(file,42,i+1);lib.state="ready";
    const prepared=path.join(library.directory,"prepared");await mkdir(prepared,{recursive:true});
    lib.output=path.join(prepared,`${lib.id}.mp4`);await writeFile(lib.output,`prepared episode ${i+1}`);
    selected.push({index:i,episode:i+1,downloaded:(await stat(file)).size,libraryId:lib.id});
    files.push({index:i,path:name,video:true,bytes:(await stat(file)).size});
  }
  await library.save();
  const downloads={jobs:[{id,title:42,folder,state:"ready",files,selected}],library,active:new Map(),serial:fn=>fn(),save:async()=>{},checkRemoval(f){if(f.state==="preparing"||f.inUse)throw new Error("Серия используется");}};
  const manager=new StorageLocations(dir,downloads);
  // Two directories stand in for physical filesystems in engine tests. Registration is tested separately.
  manager.locations=[{id:"a",folder:source,label:"A"},{id:"b",folder:target,label:"B"}];manager.defaultId="a";await manager.save();
  return {dir,source,target,folder,library,downloads,manager,cleanup:async()=>{if(targetBase){assert.ok(path.resolve(target).startsWith(path.resolve(targetBase)+path.sep));assert.match(path.basename(target),/^storage-move-[a-f0-9-]+$/);await rm(target,{recursive:true,force:true});}await rm(dir,{recursive:true,force:true});}};
}

test("moves complete seasons and prepared copies, preserves IDs/content and safely replays",async()=>{
  const f=await fixture();try {
    const ids=f.library.files.map(l=>l.id),oldOutputs=f.library.files.map(l=>l.output);
    await f.manager.moveTitles([{title:42,episodes:2}],"b","command");
    assert.equal(f.downloads.jobs[0].folder,path.join(f.target,f.downloads.jobs[0].id));
    assert.deepEqual(f.library.files.map(l=>l.id),ids);
    for(const [i,lib] of f.library.files.entries()) {
      assert.equal(await readFile(lib.path,"utf8"),`original episode ${i+1}`);
      assert.equal(await readFile(lib.output,"utf8"),`prepared episode ${i+1}`);
      assert.equal(lib.state,"ready");assert.ok(lib.output.startsWith(f.target+path.sep));
      await assert.rejects(access(oldOutputs[i]),{code:"ENOENT"});
    }
    await assert.rejects(access(f.folder),{code:"ENOENT"});
    await f.manager.moveTitles([{title:42,episodes:2}],"b","command");
    await f.library.remove(ids[0]);await assert.rejects(access(path.join(f.downloads.jobs[0].folder,".prepared",`${ids[0]}.mp4`)),{code:"ENOENT"});
  }finally{await f.cleanup();}
});

test("refuses incomplete seasons, active playback and collisions without altering originals",async()=>{
  const f=await fixture();try {
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:3}],"b"),/всех серий/);
    f.library.files[0].inUse=true;
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:2}],"b"),/используется/);f.library.files[0].inUse=false;
    const collision=path.join(f.target,f.downloads.jobs[0].id);await mkdir(collision);await writeFile(path.join(collision,"keep"),"unrelated");
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:2}],"b"),/существует/);
    assert.equal(await readFile(path.join(collision,"keep"),"utf8"),"unrelated");
    assert.equal(await readFile(f.library.files[0].path,"utf8"),"original episode 1");
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:2}],"unknown"),/не подключён/);
  }finally{await f.cleanup();}
});

test("restart finishes a verified move if the process stopped before metadata commit",async()=>{
  const f=await fixture();try {
    f.manager.finish=async()=>{throw new Error("simulated process stop");};
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:2}],"b"),/simulated/);
    assert.equal(f.library.files[0].state,"moving");
    const resumed=new StorageLocations(f.dir,f.downloads);resumed.locations=f.manager.locations;
    await resumed.recover();
    assert.equal(f.library.files[0].state,"ready");assert.ok(f.library.files[0].path.startsWith(f.target+path.sep));
    assert.equal(await readFile(f.library.files[0].path,"utf8"),"original episode 1");
    await assert.rejects(access(resumed.journal),{code:"ENOENT"});
  }finally{await f.cleanup();}
});

test("a changed destination after interruption never causes deletion of its original",async()=>{
  const f=await fixture();try {
    f.manager.finish=async()=>{throw new Error("stop");};
    await assert.rejects(f.manager.moveTitles([{title:42,episodes:2}],"b"));
    const journal=JSON.parse(await readFile(f.manager.journal,"utf8"));await writeFile(journal.plans[0].dest,"damaged copy");
    const resumed=new StorageLocations(f.dir,f.downloads);resumed.locations=f.manager.locations;
    await assert.rejects(resumed.recover(),/Исходники сохранены/);
    assert.equal(await readFile(journal.plans[0].source,"utf8"),"original episode 1");
  }finally{await f.cleanup();}
});

test("registration deduplicates a filesystem, persists defaults and does not publish paths",async()=>{
  const f=await fixture();try {
    const manager=new StorageLocations(path.join(f.dir,"new-state"),f.downloads);await manager.load(f.source);
    const sameDisk=path.join(f.dir,"same-disk");await mkdir(sameDisk);
    const a=manager.locations[0],another=await manager.add(sameDisk);assert.equal(another.id,a.id);
    const publicData=await manager.publicLocations();assert.equal(publicData.length,1);assert.ok(!JSON.stringify(publicData).includes(f.dir));
    await manager.setDefault(a.id);assert.equal(manager.root(),a.folder);
  }finally{await f.cleanup();}
});
