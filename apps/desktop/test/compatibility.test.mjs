import {test} from "node:test";
import assert from "node:assert/strict";
import {ServerCompatibility,assessServer,clientCapabilities} from "../src/compatibility.mjs";
const manifest=()=>({service:"home_theater",desktopProtocol:2,desktop:{manifestVersion:1,protocol:{min:2,max:2},capabilities:[...clientCapabilities],requiredClientCapabilities:[...clientCapabilities]}});
test("new desktop supports deployed protocol 2 and explicit manifests, not unknown legacy protocols",()=>{
  assert(assessServer({service:"home_theater",desktopProtocol:2}).legacy);
  assert(!assessServer(manifest()).legacy);
  for(const desktopProtocol of[undefined,1,3,"2"])assert.throws(()=>assessServer({service:"home_theater",desktopProtocol}));
  const m=manifest();m.desktop.protocol={min:1,max:3};assert.equal(assessServer(m).protocol,2);
});
test("unknown schemas, required capabilities and ranges cannot silently fall back to legacy",()=>{
  for(const change of[m=>m.desktop.manifestVersion=2,m=>m.desktop.protocol.min=3,m=>m.desktop.capabilities.pop(),m=>m.desktop.requiredClientCapabilities.push("future-commands-v3"),m=>m.desktop.capabilities=null,m=>m.service="other"]){const m=manifest();change(m);assert.throws(()=>assessServer(m));}
});
test("handshake is anonymous, deduplicated, per origin, short lived and cannot use stale success",async()=>{
  let now=0,calls=0,release,bad=false;
  const gate=new ServerCompatibility(async(url,options)=>{calls++;assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");assert.equal(options.cache,"no-store");assert(!options.headers.Authorization);assert(!options.headers.Cookie);if(release)await release;return Response.json(bad?{service:"other"}:manifest());},{clock:()=>now,ttl:10});
  let done;release=new Promise(r=>{done=r;});const a=gate.ensure("https://one.example"),b=gate.ensure("https://one.example");assert.equal(calls,1);done();await Promise.all([a,b]);release=null;
  await gate.ensure("https://one.example");assert.equal(calls,1);await gate.ensure("https://two.example");assert.equal(calls,2);
  now=11;bad=true;await assert.rejects(gate.ensure("https://one.example"));assert.equal(calls,3);await assert.rejects(gate.ensure("https://one.example"));assert.equal(calls,3);
  bad=false;await gate.ensure("https://one.example",{force:true});assert.equal(calls,4);
});
test("426 revokes in-flight admission and explicit retry is required",async()=>{
  let finish;const waiting=new Promise(r=>{finish=r;});const gate=new ServerCompatibility(async()=>{await waiting;return Response.json(manifest());});
  const checking=gate.ensure("https://one.example");gate.reject("https://one.example","protocol changed");finish();await assert.rejects(checking);await assert.rejects(gate.ensure("https://one.example"),/protocol changed/);await gate.ensure("https://one.example",{force:true});
});
test("offline, redirects, maintenance, non-JSON and malformed servers block without credential fallback",async()=>{
  for(const fetcher of[async()=>{throw new TypeError("fetch failed");},async()=>new Response("",{status:302}),async()=>new Response("",{status:503}),async()=>new Response("<html>login</html>"),async()=>Response.json({service:"home_theater",desktop:null})]){const gate=new ServerCompatibility(fetcher);await assert.rejects(gate.ensure("https://one.example"));}
});
test("cold proxy connections wait for TLS within the bootstrap budget and report validation separately",async()=>{
  const states=[];let signal;
  const gate=new ServerCompatibility(async(_url,options)=>{signal=options.signal;await new Promise(r=>setTimeout(r,25));assert(!signal.aborted);return Response.json(manifest());},{requestTimeout:100,getRoute:async()=>"proxy",onState:(_origin,state)=>states.push(state)});
  await gate.ensure("https://one.example");assert(states.some(s=>s.phase==="connecting"&&s.route==="proxy"));assert(states.some(s=>s.phase==="validating"));assert.equal(states.at(-1).status,"ready");
});
test("proxy timeout is a transport error, not a protocol mismatch; failure stays closed",async()=>{
  const states=[];const keepAlive=setTimeout(()=>{},200);
  try{const gate=new ServerCompatibility((_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason))),{requestTimeout:20,getRoute:async()=>"proxy",onState:(_origin,state)=>states.push(state)});
    await assert.rejects(gate.ensure("https://one.example"),e=>e.code==="SERVER_CONNECTION_TIMEOUT");assert.equal(states.at(-1).code,"SERVER_CONNECTION_TIMEOUT");assert.match(states.at(-1).error,/системный прокси/);assert.equal(states.at(-1).status,"blocked");
  }finally{clearTimeout(keepAlive);}
});
test("a revoked in-flight probe cannot replace the blocked state with validation progress",async()=>{
  const states=[];let resolve;const ready=new Promise(r=>{resolve=r;});
  const gate=new ServerCompatibility(async()=>{await ready;return Response.json(manifest());},{onState:(_origin,s)=>states.push(s)});
  const pending=gate.ensure("https://one.example");gate.reject("https://one.example","revoked");resolve();await assert.rejects(pending);assert.equal(states.at(-1).status,"blocked");
});
test("one transport retry stays anonymous and on the same endpoint; incompatible responses are never retried",async()=>{
  const calls=[];const gate=new ServerCompatibility(async(url,options)=>{calls.push({url,options});if(calls.length===1)throw new TypeError("connection closed");return Response.json(manifest());});
  await gate.ensure("https://one.example");assert.equal(calls.length,2);assert.equal(calls[0].url,calls[1].url);assert(calls.every(c=>c.options.credentials==="omit"&&!c.options.headers.Authorization));
  let count=0;const bad=new ServerCompatibility(async()=>{count++;return Response.json({service:"other"});});await assert.rejects(bad.ensure("https://one.example"));assert.equal(count,1);
});
