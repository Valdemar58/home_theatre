import type { CommentItem } from "./types";
/** Page complete visible threads; never split a reply from its visible root. */
export function commentPage(items:CommentItem[],episode:number|null,before:number|null,limit=12) {
 const map=new Map(items.map(c=>[c.id,c]));
 const root=(c:CommentItem)=>{const visited=new Set<number>();while(c.parentId!==null&&map.has(c.parentId)&&!visited.has(c.id)){visited.add(c.id);c=map.get(c.parentId)!;}return c;};
 const roots=items.filter(c=>root(c).id===c.id&&(episode===null||c.episode===episode)).sort((a,b)=>b.id-a.id).filter(c=>before===null||c.id<before);
 const page=roots.slice(0,limit),ids=new Set(page.map(c=>c.id));
 return {items:items.filter(c=>ids.has(root(c).id)),next:roots.length>limit?page.at(-1)!.id:null};
}
