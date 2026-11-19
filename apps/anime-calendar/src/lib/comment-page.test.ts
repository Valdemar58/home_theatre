import { describe,it,expect } from "vitest";
import { commentPage } from "./comment-page";
import type { CommentItem } from "./types";
const c=(id:number,parentId:number|null,episode=1):CommentItem=>({id,parentId,episode,createdAt:id,user:{id:1,name:"test"},body:"test",spoiler:false,editedAt:null,deleted:false,mine:false,score:null});
describe("comment pages",()=>{
 it("keeps nested replies with their root and loads older roots without duplicates",()=>{const all=[c(1,null),c(2,1),c(3,2),c(4,null),c(5,3),c(6,null,2)];const page=commentPage(all,1,null,1);expect(page.items.map(c=>c.id)).toEqual([4]);expect(page.next).toBe(4);const older=commentPage(all,1,page.next,1);expect(older.items.map(c=>c.id)).toEqual([1,2,3,5]);expect(older.next).toBeNull();});
 it("handles a hidden parent without exposing another episode",()=>{expect(commentPage([c(2,999,2),c(3,2,2),c(4,null,1)],1,null).items.map(c=>c.id)).toEqual([4]);});
});
