import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./sync",()=>({schedulePush:vi.fn()}));
process.env.DATABASE_DRIVER=process.env.POSTGRES_TEST==="1"?"postgres":"sqlite";
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),"watch-history-"));
const{db}=await import("./db");
const{getRow,saveMedia,upsertEntry}=await import("./lists");
const{applyCoverage,personalHistory,markEpisode,inactivityTick,setInactivity,revokeOwnEvent}=await import("./watch-history");
const{coverageAttempt,recordCoverage}=await import("./watch-coverage");
const{correctMeeting,previewMeeting,groupEpisodes,meetingResult,recordMeetingCoverage}=await import("./meeting-history");
const{groupTick}=await import("./groups");
let clock:number,group:number,meeting:number;
const media=(id=10,status="FINISHED",episodes=3,nextAiringEpisode:null|{episode:number;airingAt:number}=null)=>({id,idMal:null,title:{romaji:`Title ${id}`},episodes,duration:24,status,nextAiringEpisode,coverImage:{large:null,color:null}} as unknown as import("@/lib/types").MediaLite);
const report=(sid:string,ep:number,intervals:number[][],user=1)=>{
  const s={sid,userId:user,anilistId:10,ep,duration:1000};
  const e=recordCoverage(s,intervals);return applyCoverage(user,10,ep,sid,1000,e.changed);
};
beforeEach(()=>{
  vi.restoreAllMocks();clock=Date.parse("2026-11-17T12:00:00Z");vi.spyOn(Date,"now").mockImplementation(()=>clock);
  db.exec("DELETE FROM shared_lists; DELETE FROM users; DELETE FROM media;");
  for(const id of[1,2,3])db.prepare("INSERT INTO users(id,jellyfin_id,name,created_at) VALUES(?,?,?,0)").run(id,String(id),`user${id}`);
  saveMedia([media()]);
  group=Number(db.prepare("INSERT INTO shared_lists(name,owner_id,created_at) VALUES('test',1,0)").run().lastInsertRowid);
  for(const id of[1,2])db.prepare("INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(?,?,'member',0)").run(group,id);
  meeting=Number(db.prepare("INSERT INTO group_sessions(list_id,anilist_id,ep,count,starts_at,created_by,created_at,status) VALUES(?,10,1,2,0,1,0,'missed')").run(group).lastInsertRowid);
});
it("starts at 10%, completes episodes at 80%, never uses the final position or sums repeated ranges",()=>{
  report("one",1,[[900,999.9]]);expect(getRow(1,10)).toBeUndefined();
  report("one",1,[[900,1000]]);expect(getRow(1,10)?.status).toBe("watching");
  expect(getRow(1,10)?.episodes).toBe(0);
  report("one",1,[[0,699.9]]);expect(personalHistory(1,10)[0].episodes).toEqual([]);
  report("one",1,[[0,700]]);expect(personalHistory(1,10)[0].episodes).toEqual([1]);
  report("one",1,[[0,700]]);expect(personalHistory(1,10)[0].events).toHaveLength(1);
});
it("does not complete a title from its final episode or two selected episodes",()=>{
  markEpisode(1,10,3);expect(getRow(1,10)?.status).toBe("watching");expect(getRow(1,10)?.episodes).toBe(0);
  markEpisode(1,10,1);expect(getRow(1,10)?.status).toBe("watching");
  markEpisode(1,10,2);expect(getRow(1,10)?.status).toBe("completed");
});
it("starts a new rewatch at 10% and preserves the original completion on timeout",()=>{
  [1,2,3].forEach(ep=>markEpisode(1,10,ep));
  report("rewatch",2,[[0,99.9]]);expect(getRow(1,10)?.status).toBe("completed");
  report("rewatch",2,[[0,100]]);expect(getRow(1,10)?.status).toBe("rewatching");
  clock+=61*86400000;inactivityTick();expect(getRow(1,10)?.status).toBe("completed");
  expect(personalHistory(1,10)).toHaveLength(2);
  expect(personalHistory(1,10).some(c=>c.outcome==="completed")).toBe(true);
});
it("preserves manual marks through late heartbeat and prevents old attempts changing new cycles",()=>{
  report("a",1,[[0,200]]);markEpisode(1,10,1);report("a",1,[[0,250]]);
  expect(personalHistory(1,10)[0].episodes).toEqual([1]);
  markEpisode(1,10,2);markEpisode(1,10,3);report("new",1,[[0,100]]);report("a",1,[[0,950]]);
  expect(getRow(1,10)?.status).toBe("rewatching");expect(personalHistory(1,10)[0].episodes).toEqual([]);
});
it("waiting for releases is not inactivity, and timeout is personally configurable",()=>{
  saveMedia([media(10,"RELEASING",3,{episode:2,airingAt:clock/1000+100})]);markEpisode(1,10,1);
  clock+=70*86400000;inactivityTick();expect(getRow(1,10)?.status).toBe("watching");
  saveMedia([media(10,"RELEASING",3,{episode:3,airingAt:clock/1000+100})]);inactivityTick();
  clock+=59*86400000;inactivityTick();expect(getRow(1,10)?.status).toBe("watching");
  clock+=2*86400000;inactivityTick();expect(getRow(1,10)?.status).toBe("dropped");
  report("resume",2,[[0,100]]);setInactivity(1,0);clock+=500*86400000;inactivityTick();expect(getRow(1,10)?.status).toBe("watching");
});
it("keeps group history independent from personal progress and future members",()=>{
  markEpisode(1,10,3);expect(groupEpisodes(group,10)).toEqual([]);
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[1,3]}],attendees:[2],note:"outside"},1);
  expect(groupEpisodes(group,10)).toEqual([1,3]);expect(personalHistory(2,10)[0].episodes).toEqual([1,3]);
  expect(personalHistory(1,10)[0].episodes).toEqual([3]);
  db.prepare("INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(?,3,'member',0)").run(group);
  expect(groupEpisodes(group,10)).toEqual([1,3]);expect(getRow(3,10)).toBeUndefined();
});
it("previews without mutations, checks permissions and rejects duplicate stale saves",()=>{
  const body={results:[{anilistId:10,episodes:[1]}],attendees:[2],note:""};
  expect(()=>previewMeeting(2,meeting,body,1)).toThrow();
  previewMeeting(1,meeting,body,1);expect(personalHistory(2)).toEqual([]);
  correctMeeting(1,meeting,body,1);expect(()=>correctMeeting(1,meeting,body,1)).toThrow();
  expect(meetingResult(meeting).journal).toHaveLength(1);
});
it("corrects exact episodes without erasing measured playback or a member's own correction",()=>{
  report("viewer",2,[[0,800]],2);
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[1,3]}],attendees:[2],note:""},1);
  const e=personalHistory(2,10)[0].events.find(e=>e.source==="organizer"&&e.ep===1)!;
  revokeOwnEvent(2,e.id);expect(()=>revokeOwnEvent(1,e.id)).toThrow();
  const preview=previewMeeting(1,meeting,{results:[{anilistId:10,episodes:[1]}],attendees:[2],note:"correction"},2);
  expect(preview.changes[0].added).toEqual([]);
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[1]}],attendees:[2],note:"correction"},2);
  expect(personalHistory(2,10)[0].episodes).toEqual([2]);expect(groupEpisodes(group,10)).toEqual([1]);
});
it("uses exact Jellyfin receipt keys, not a repeated positional increment",()=>{
  markEpisode(1,10,1,"jellyfin","receipt-1");markEpisode(1,10,1,"jellyfin","receipt-1");
  expect(personalHistory(1,10)[0].events).toHaveLength(1);
});
it("does not fabricate old event history",()=>{
  upsertEntry(1,media(),{status:"watching",episodes:1});report("legacy",2,[[0,100]]);
  const c=personalHistory(1,10)[0];expect(c.baseline).toBe(1);expect(c.events).toEqual([]);
});
it("expires an unstarted meeting exactly two hours after its planned start and permits correction",async()=>{
  db.prepare("UPDATE group_sessions SET status='planned',starts_at=? WHERE id=?").run(clock/1000-7200,meeting);
  await groupTick();expect(db.prepare<[number],{status:string}>("SELECT status FROM group_sessions WHERE id=?").get(meeting)?.status).toBe("missed");
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[2]}],attendees:[],note:"outside"},1);
  expect(groupEpisodes(group,10)).toEqual([2]);expect(getRow(1,10)).toBeUndefined();
});
it("projects activity once per exact episode and removes corrected credits without touching other evidence",()=>{
  report("real",1,[[0,800]],2);markEpisode(2,10,1);
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[2]}],attendees:[2],note:""},1);
  correctMeeting(1,meeting,{results:[],attendees:[],note:""},2);
  expect(db.prepare<[],{n:number}>("SELECT SUM(episodes) n FROM watch_log WHERE user_id=2").get()?.n).toBe(1);
});
it("restores the previous completed status when a mistaken organizer rewatch mark is revoked",()=>{
  upsertEntry(2,media(),{status:"completed"});
  correctMeeting(1,meeting,{results:[{anilistId:10,episodes:[1]}],attendees:[2],note:""},1);
  expect(getRow(2,10)?.status).toBe("rewatching");
  revokeOwnEvent(2,personalHistory(2,10)[0].events[0].id);
  expect(getRow(2,10)?.status).toBe("completed");
});
it("only records a connected matching viewer in a matching meeting revision",()=>{
  const state={ep:1,pos:0,at:clock,playing:true,hold:[],session:{sessionId:meeting,revision:1,phase:"watching"}};
  db.prepare("INSERT INTO watch_rooms(id,owner_id,anilist_id,preset,state,created_at,last_activity,group_id,session_id) VALUES('room',1,10,'equal',?,0,0,?,?)").run(JSON.stringify(state),group,meeting);
  db.prepare("INSERT INTO watch_room_members(room_id,user_id,status,joined_at) VALUES('room',1,'joined',0)").run();
  recordMeetingCoverage(2,"room",1,10,1,"absent",1000,[[0,1000]]);expect(groupEpisodes(group,10)).toEqual([]);
  recordMeetingCoverage(1,"room",0,10,1,"stale",1000,[[0,1000]]);expect(groupEpisodes(group,10)).toEqual([]);
  recordMeetingCoverage(1,"room",1,10,1,"actual",1000,[[0,800]]);expect(groupEpisodes(group,10)).toEqual([1]);
  expect(getRow(2,10)).toBeUndefined();
});
