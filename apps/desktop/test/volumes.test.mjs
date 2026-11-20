import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm,access,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { windowsVolumes,linuxVolumes,volumeFor } from "../src/volumes.mjs";
import { StorageLocations } from "../src/storage-locations.mjs";

test("volume identities survive drive-letter and mount-point changes; readonly and unmounted Linux volumes are excluded",()=>{
  const a=windowsVolumes({DeviceID:"Volume-GUID",DriveLetter:"D:",Label:"Media"})[0];
  const b=windowsVolumes({DeviceID:"volume-guid",DriveLetter:"E:"})[0];
  assert.equal(a.id,b.id);assert.notEqual(a.root,b.root);
  const disk=(mountpoints,extra={})=>({uuid:"UUID-1",type:"part",ro:false,mountpoints,...extra});
  const linux=linuxVolumes({blockdevices:[{children:[disk(["/mnt/media"]),disk(["/mnt/alias"]),disk([null],{uuid:"2"}),disk(["/boot"],{uuid:"3"}),disk(["/mnt/locked"],{uuid:"4",ro:true})]}]});
  assert.equal(linux.length,1);
  assert.equal(linux[0].id,linuxVolumes({blockdevices:[disk(["/media/moved"])]})[0].id);
  const root=path.parse(process.cwd()).root;
  assert.equal(volumeFor(path.join(root,"media","a"),[{root,id:"root"},{root:path.join(root,"media"),id:"child"}]).id,"child");
  assert.equal(volumeFor(path.join(root,"medial"),[{root:path.join(root,"media"),id:"child"}]),undefined);
});

test("one folder per stable volume, frozen until empty; disconnect survives restart and never deletes files",async()=>{
  // Windows runners may expose TEMP through an 8.3 alias; use the same canonical
  // path representation as registered library roots.
  const dir=await realpath(await mkdtemp(path.join(tmpdir(),"storage-volume-")));
  try {
    const disk=path.join(dir,"disk"),first=path.join(disk,"library"),second=path.join(disk,"another");await mkdir(disk);
    const downloads={jobs:[],library:{files:[]},save:async()=>{},serial:fn=>fn()};
    let id="physical-a";
    const detect=async()=>[{id,root:disk,online:true,label:"Disk",total:1000,free:500}];
    const manager=new StorageLocations(path.join(dir,"state"),downloads,{detect});await manager.load(first);
    const original=manager.locations[0];
    assert.equal((await manager.available())[0].registered,original.id);
    await writeFile(path.join(first,"keep"),"user data");
    assert.equal((await manager.add(second,"physical-a")).id,original.id);
    assert.equal(manager.root(),first);await assert.rejects(access(second),{code:"ENOENT"});
    assert.equal(await manager.canDisconnect(original.id),false);
    await assert.rejects(manager.disconnect(original.id),/непустая/);
    assert.equal(await readFile(path.join(first,"keep"),"utf8"),"user data");
    const outside=path.join(dir,"wrong-volume");
    await assert.rejects(manager.add(outside,"physical-a"),/выбранном томе/);await assert.rejects(access(outside),{code:"ENOENT"});
    id="physical-b";await manager.scan(true);
    await assert.rejects(manager.checkedRoot(),/другой диск/);
    assert.equal(await manager.canDisconnect(original.id),false);
    id="physical-a";await manager.scan(true);await rm(path.join(first,"keep"));
    assert.equal(await manager.canDisconnect(original.id),true);await manager.disconnect(original.id);
    await access(first);assert.equal(manager.locations.length,0);
    const restored=new StorageLocations(path.join(dir,"state"),downloads,{detect});await restored.load(first);
    assert.equal(restored.locations.length,0);assert.equal(restored.defaultId,"");
    const connected=await restored.add(second,"physical-a");assert.equal(connected.folder,second);assert.notEqual(connected.id,original.id);
  } finally {assert.ok(path.resolve(dir).startsWith(await realpath(tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});
