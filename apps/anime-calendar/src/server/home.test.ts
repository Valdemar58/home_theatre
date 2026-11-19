import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./sync",()=>({schedulePush:vi.fn()}));
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),"home-"));
const {db,now}=await import("./db");
const {saveMedia,upsertEntry}=await import("./lists");
const {markEpisode}=await import("./watch-history");
const {homeData}=await import("./home");
const {beginPairing,approveDevice,revokeDevice}=await import("./desktop");
const {enqueue}=await import("./desktop-commands");
const media=(id=10,status="FINISHED",nextAiringEpisode:null|{episode:number;airingAt:number}=null)=>({id,idMal:null,title:{romaji:`Title ${id}`},episodes:12,duration:24,status,nextAiringEpisode,coverImage:{large:null,color:null}} as unknown as import("@/lib/types").MediaLite);
beforeEach(()=>{
  db.exec("DELETE FROM shared_lists; DELETE FROM desktop_devices; DELETE FROM users; DELETE FROM media;");
  db.exec("INSERT INTO users(id,jellyfin_id,name,created_at) VALUES(1,'one','One',0),(2,'two','Two',0)");
  saveMedia([media()]);
});
it("does not offer unreleased episodes and keeps gaps in the current cycle",()=>{
  markEpisode(1,10,1);markEpisode(1,10,3);
  expect(homeData(1).continuing[0].ep).toBe(2);
  saveMedia([media(10,"RELEASING",{episode:2,airingAt:now()+3600})]);
  expect(homeData(1).continuing[0].available).toBe(false);
  expect(homeData(2).continuing).toEqual([]);
});
it("shows only owned, non-revoked device queues",()=>{
  const one=beginPairing("Home","win32"),two=beginPairing("Other","linux");
  approveDevice(one.id,1);approveDevice(two.id,2);enqueue(1,one.id,"pause",{});
  expect(homeData(1).devices.map(d=>[d.id,d.queued,d.online])).toEqual([[one.id,1,false]]);
  revokeDevice(one.id,1);expect(homeData(1).devices).toEqual([]);
});
it("excludes invitations and expired plans, prioritizes live sessions",()=>{
  const group=Number(db.prepare("INSERT INTO shared_lists(name,owner_id,created_at) VALUES('Room',1,0)").run().lastInsertRowid);
  db.prepare("INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(?,1,'member',0),(?,2,'invited',0)").run(group,group);
  const add=(start:number,status:string)=>Number(db.prepare("INSERT INTO group_sessions(list_id,anilist_id,ep,count,starts_at,created_by,created_at,status) VALUES(?,10,1,2,?,1,0,?)").run(group,start,status).lastInsertRowid);
  add(now()-7201,"planned");const future=add(now()+3600,"planned");
  expect(homeData(1).next?.id).toBe(future);expect(homeData(2).next).toBeNull();
  const live=add(now(),"live");expect(homeData(1).next?.id).toBe(live);
});
it("does not start a new rewatch from a completed list entry",()=>{
  upsertEntry(1,media(),{status:"completed"});expect(homeData(1).continuing).toEqual([]);
});
it("continues the recently played unfinished episode, including non-sequential viewing",()=>{
  upsertEntry(1,media(),{status:"watching",episodes:0});
  db.prepare("INSERT INTO playback_pos(user_id,anilist_id,ep,pos,dur,updated_at) VALUES(1,10,4,120,1440,?)").run(now());
  expect(homeData(1).continuing[0]).toMatchObject({ep:4,position:120,available:true});
});
