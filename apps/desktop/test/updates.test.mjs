import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {StartupUpdates,defaultChannel} from "../src/updates.mjs";
const info=version=>({version,files:[{url:`app-${version}.exe`,sha512:createHash("sha512").update(version).digest("base64"),size:100}]});
async function fixture(t,{version="1.0.0",latest="1.0.0",packaged=true,...options}={}){
  const prefix=join(tmpdir(),"home-theater-updates-"),dir=await mkdtemp(prefix);
  t.after(async()=>{assert(dir.startsWith(prefix));await rm(dir,{recursive:true,force:true});});
  const calls={checks:0,downloads:[],installs:0};
  const adapter={configure:async channel=>{calls.channel=channel;},check:async()=>{calls.checks++;return info(latest);},download:async progress=>{calls.downloads.push(true);progress({percent:100,transferred:100,total:100});},install:async()=>{calls.installs++;},onError:fn=>{adapter.error=fn;}};
  const u=new StartupUpdates({directory:dir,version,adapter,packaged,...options});let connected=false;u.ready.then(()=>{connected=true;});
  return {dir,u,adapter,calls,connected:()=>connected};
}
test("startup waits for a verified current release before allowing services",async t=>{
  const f=await fixture(t);let release,started;const checking=new Promise(resolve=>{started=resolve;});f.adapter.check=()=>new Promise(resolve=>{release=resolve;started();});const pending=f.u.run();await checking;assert.equal(f.connected(),false);assert.equal(await f.u.run(),false);release(info("1.0.0"));assert.equal(await pending,true);await f.u.ready;assert(f.connected());assert.equal(f.calls.installs,0);
});
test("one direct update preserves profile bytes and waits for the new process",async t=>{
  const f=await fixture(t,{latest:"1.9.0"});const bytes=JSON.stringify({version:2,activeId:"kept",profiles:[{settings:{secret:"encrypted",deviceId:"device"}}]});await writeFile(join(f.dir,"host.json"),bytes);
  assert.equal(await f.u.run(),false);assert.equal(f.calls.downloads.length,1);assert.equal(f.calls.installs,1);assert(!f.connected());
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,"updates.json"),"utf8")).attempt.from,"1.0.0");
  const next=new StartupUpdates({directory:f.dir,version:"1.9.0",adapter:f.adapter});assert.equal(await next.run(),true);await next.ready;
  assert.equal(await readFile(join(f.dir,"host.json"),"utf8"),bytes);assert.equal(JSON.parse(await readFile(join(f.dir,"updates.json"),"utf8")).attempt,null);
});
test("a newer release during download replaces the target before one installation",async t=>{
  const f=await fixture(t);let n=0;f.adapter.check=async()=>info(++n===1?"1.2.0":"1.3.0");await f.u.run();assert.equal(f.calls.downloads.length,2);assert.equal(f.calls.installs,1);assert.equal(f.u.state.target,"1.3.0");assert(!f.connected());
});
test("feed failure never connects; retry can recover",async t=>{
  const f=await fixture(t);f.adapter.check=async()=>{throw Error("offline");};await f.u.run();assert.equal(f.u.state.status,"error");assert(!f.connected());assert.equal(f.calls.installs,0);f.adapter.check=async()=>info("1.0.0");assert.equal(await f.u.run({retry:true}),true);await f.u.ready;
});
test("metadata timeout leaves the startup barrier closed",async t=>{
  const f=await fixture(t,{checkTimeout:10});f.adapter.check=()=>new Promise(()=>{});await f.u.run();assert.equal(f.u.state.code,"UPDATE_TIMEOUT");assert(!f.connected());
});
test("bad checksum cannot launch the installer or services",async t=>{
  const f=await fixture(t,{latest:"2.0.0"});f.adapter.download=async()=>{throw Object.assign(Error("bad hash"),{code:"ERR_UPDATER_CHECKSUM_MISMATCH"});};await f.u.run();assert.equal(f.u.state.status,"error");assert.match(f.u.state.error,/Проверка установщика/);assert.equal(f.calls.installs,0);assert(!f.connected());
});
test("download inactivity cancels the transfer and keeps services blocked",async t=>{
  const f=await fixture(t,{latest:"2.0.0",downloadTimeout:10});f.adapter.download=(_p,signal)=>new Promise((_r,reject)=>signal.addEventListener("abort",()=>reject(Error("aborted")),{once:true}));await f.u.run();assert.equal(f.u.state.status,"error");assert.equal(f.calls.installs,0);assert(!f.connected());
});
test("failed installation does not create an automatic restart loop",async t=>{
  const f=await fixture(t,{latest:"2.0.0"});await writeFile(join(f.dir,"updates.json"),JSON.stringify({schema:1,channel:"stable",attempt:{from:"1.0.0",to:"2.0.0"}}));await f.u.run();assert.equal(f.u.state.code,"INSTALL_NOT_COMPLETED");assert.equal(f.calls.installs,0);await f.u.run({retry:true});assert.equal(f.calls.installs,1);assert(!f.connected());
});
test("synchronous installer failure is visible and never opens the server",async t=>{
  const f=await fixture(t,{latest:"2.0.0"});f.adapter.install=async()=>{throw Error("could not spawn installer");};await f.u.run();assert.equal(f.u.state.status,"error");assert(!f.connected());
});
test("asynchronous installer errors retain a retryable blocked state",async t=>{
  const f=await fixture(t,{latest:"2.0.0"});await f.u.run();f.adapter.error(Error("spawn failed"));assert.equal(f.u.state.status,"error");assert(!f.connected());
});
test("stable cannot silently consume a prerelease",async t=>{
  const f=await fixture(t,{latest:"2.0.0-rc.1"});await f.u.run();assert.equal(f.u.state.code,"UPDATE_CHANNEL_MISMATCH");assert.equal(f.calls.installs,0);assert(!f.connected());
});
test("preview is an explicit persistent channel and does not require a server profile",async t=>{
  const f=await fixture(t,{version:"1.0.0-rc.1",latest:"1.0.0-rc.2"});await f.u.run();assert.equal(f.calls.channel,"preview");assert.equal(f.calls.installs,1);assert.equal(JSON.parse(await readFile(join(f.dir,"updates.json"),"utf8")).channel,"preview");
  assert.equal(defaultChannel("1.0.0"),"stable");assert.equal(defaultChannel("1.0.0-rc.1"),"preview");
});
test("malformed metadata cannot masquerade as an up-to-date release",async t=>{
  const f=await fixture(t);f.adapter.check=async()=>({version:"1.0.0"});await f.u.run();assert.equal(f.u.state.code,"INVALID_UPDATE_VERSION");assert(!f.connected());
});
test("settings failure does not modify account or media data",async t=>{
  const f=await fixture(t);await writeFile(join(f.dir,"updates.json"),"broken");await writeFile(join(f.dir,"host.json"),"keep-exactly");await f.u.run();assert.equal(f.u.state.code,"INVALID_UPDATE_SETTINGS");assert.equal(await readFile(join(f.dir,"host.json"),"utf8"),"keep-exactly");assert(!f.connected());
});
test("development skips distribution checks; packaged builds never skip them",async t=>{
  const f=await fixture(t,{packaged:false});assert.equal(await f.u.run(),true);assert.equal(f.u.state.status,"development");assert.equal(f.calls.checks,0);
});
