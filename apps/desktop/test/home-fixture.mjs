// Synthetic local UI fixture only. Never uses the production database.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const db=new DatabaseSync(fileURLToPath(new URL('../release/m6-data/anime-calendar.db',import.meta.url)));
const now=Math.floor(Date.now()/1000);
const media=JSON.parse(db.prepare('SELECT json FROM media WHERE anilist_id=42').get().json);
const other={...media,id:43,title:{...media.title,ru:'Тестовый второй тайтл'},episodes:12,status:'FINISHED',nextAiringEpisode:null};
db.prepare('INSERT INTO media(anilist_id,json,updated_at) VALUES(43,?,?) ON CONFLICT(anilist_id) DO UPDATE SET json=excluded.json').run(JSON.stringify(other),now);
db.prepare("UPDATE group_sessions SET status='cancelled' WHERE list_id=1 AND status IN ('planned','live')").run();
db.prepare("INSERT INTO group_sessions(list_id,anilist_id,ep,count,starts_at,created_by,created_at,status,plan_json) VALUES(1,42,2,1,?,1,?,'planned',?)").run(now+3600,now,JSON.stringify({blocks:[{anilistId:42,episodes:[2],breakMinutes:10,durationMinutes:24,durationSource:'estimate'},{anilistId:43,episodes:[1,2],breakMinutes:0,durationMinutes:24,durationSource:'estimate'}],skipCredits:true,timeZone:'Europe/Berlin'}));
const device=db.prepare("SELECT id FROM desktop_devices WHERE user_id=1 AND label LIKE 'M7%' LIMIT 1").get();
if(device) db.prepare('INSERT INTO desktop_download_state(device_id,snapshot,updated_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at').run(device.id,JSON.stringify([{id:'home-fixture',title:43,titleName:'Тестовый второй тайтл',state:'downloading',files:[{index:0,episode:1,name:"Synthetic E01.mp4",video:true,selected:true,bytes:1000,downloaded:625,prepareProgress:0}]}]),now);
db.close();console.log('Synthetic home fixture ready');

