import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
process.env.DATA_DIR=mkdtempSync(path.join(tmpdir(),"download-context-"));
const {db}=await import("./db");
const {downloadContext}=await import("./download-context");
it("shows viewers only for accepted group titles and never leaks hidden progress",()=>{
  db.exec("INSERT INTO users(id,jellyfin_id,name,created_at) VALUES(1,'a','A',0),(2,'b','B',0),(3,'c','C',0); INSERT INTO shared_lists(id,name,owner_id,created_at) VALUES(1,'Room',1,0); INSERT INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(1,1,'member',0),(1,2,'member',0),(1,3,'invited',0); INSERT INTO shared_list_items(list_id,anilist_id,added_at,planning_state) VALUES(1,42,0,'proposed'); INSERT INTO list_entries(user_id,anilist_id,status,episodes,updated_at,private) VALUES(2,42,'completed',25,0,1)");
  expect(downloadContext(1,[42])[42].people).toEqual([]);
  db.exec("UPDATE shared_list_items SET planning_state='accepted'");
  expect(downloadContext(1,[42])[42].people).toHaveLength(2);
  expect(downloadContext(1,[42])[42].people.find(p=>p.id===2)).toMatchObject({hidden:true,watched:[],baseline:0,completed:false});
  expect(downloadContext(3,[42])[42].people).toEqual([]);
});
