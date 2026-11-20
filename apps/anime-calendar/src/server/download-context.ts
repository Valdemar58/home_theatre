import "server-only";
import { db } from "./db";
import { getMedia, getRow } from "./lists";
import { latestCycle, cycleEpisodes } from "./watch-history";
import { displayTitle } from "@/lib/schedule";
import { groupEpisodes } from "./meeting-history";

export function downloadContext(user:number, titles:number[]) {
  return Object.fromEntries(titles.map(id=>{
    const media=getMedia(id), entry=getRow(user,id);
    const groups=db.prepare<[number,number],{id:number;name:string}>(`SELECT l.id,l.name FROM shared_lists l JOIN shared_list_members m ON m.list_id=l.id
      JOIN shared_list_items i ON i.list_id=l.id WHERE m.user_id=? AND m.status='member' AND i.anilist_id=? AND i.planning_state='accepted'`).all(user,id)
      .filter(g=>!media?.episodes || groupEpisodes(g.id,id).length<media.episodes);
    const people=new Map<number,{id:number;name:string;hidden:boolean;watched:number[];baseline:number;completed:boolean}>();
    for(const group of groups)for(const p of db.prepare<[number],{id:number;name:string}>("SELECT u.id,u.name FROM users u JOIN shared_list_members m ON m.user_id=u.id WHERE m.list_id=? AND m.status='member'").all(group.id)) {
      if(people.has(p.id))continue;const e=getRow(p.id,id), hidden=p.id!==user && !!e?.private;
      const cycle=!hidden ? latestCycle(p.id,id) : null;
      people.set(p.id,{...p,hidden,watched:cycle&&!cycle.ended_at?cycleEpisodes(cycle):[],baseline:hidden?0:cycle&&!cycle.ended_at?cycle.baseline:e?.episodes??0,completed:!hidden && e?.status==="completed"});
    }
    return [id,{name:media?displayTitle(media.title):`Тайтл ${id}`,episodes:media?.episodes??null,cover:media?.coverImage.large??null,status:entry?.status??null,groups,people:[...people.values()]}];
  }));
}
