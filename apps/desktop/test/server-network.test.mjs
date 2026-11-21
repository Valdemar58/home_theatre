import {test} from "node:test";
import assert from "node:assert/strict";
import {ServerNetwork} from "../src/server-network.mjs";
test("server requests preserve the matching profile session and credentials policy; no direct fallback",async()=>{
  const calls=[],sessions=new Map(["https://one.example","https://two.example"].map(origin=>[origin,{async fetch(url,options){calls.push({origin,url,options});return Response.json({ok:true});},async resolveProxy(){return origin.includes("one")?"PROXY 127.0.0.1:1234":"DIRECT";}}]));
  const network=new ServerNetwork(origin=>sessions.get(origin));
  await network.fetch("https://one.example/api/desktop/info",{credentials:"omit"});
  await network.fetch("https://two.example/api/desktop/commands",{credentials:"omit",headers:{Authorization:"Bearer test-only"}});
  assert.equal(calls[0].origin,"https://one.example");assert.equal(calls[0].options.credentials,"omit");assert.equal(calls[1].origin,"https://two.example");assert.equal(calls[1].options.headers.Authorization,"Bearer test-only");
  assert.equal(await network.route("https://one.example"),"proxy");assert.equal(await network.route("https://two.example"),"direct");
  sessions.get("https://one.example").fetch=async()=>{throw Error("proxy unavailable");};await assert.rejects(network.fetch("https://one.example/api/test",{}),/proxy unavailable/);assert.equal(calls.length,2);
});
