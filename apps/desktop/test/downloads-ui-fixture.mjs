// Visual stress fixture in the isolated synthetic database only; no real files are created.
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
const db=new DatabaseSync(fileURLToPath(new URL("../release/m6-data/anime-calendar.db",import.meta.url)));
const device=db.prepare("SELECT id FROM desktop_devices WHERE user_id=1 AND label LIKE 'M7%' LIMIT 1").get();
const files=Array.from({length:25},(_,i)=>({index:i,name:`Synthetic E${i+1}.mp4`,bytes:1024**3,video:true,episode:i+1,selected:true,downloaded:i<8?1024**3:i===8?1024**3*.62:0,prepareState:i<5?"ready":i===5?"preparing":"imported",prepareProgress:i<5?1:i===5?.35:0,preparedBytes:i<5?512*1024**2:0}));
const snapshot={jobs:[{id:"00000000-0000-4000-8000-000000000025",title:42,titleName:"Тестовый сезон · 25 серий",releaseName:"Визуальная тестовая раздача",state:"downloading",speed:0,files}],library:[],capabilities:["episode-delete-v1"],storage:{at:Date.now(),volumes:[{id:"fixture",label:"Тестовый диск",total:512*1024**3,free:180*1024**3,mediaBytes:11*1024**3,titles:[{id:42,name:"Тестовый сезон",bytes:11*1024**3}]}]}};
db.prepare("INSERT INTO desktop_download_state(device_id,snapshot,updated_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at").run(device.id,JSON.stringify(snapshot),Math.floor(Date.now()/1000));
db.prepare("INSERT INTO shared_list_items(list_id,anilist_id,added_at,planning_state) VALUES(1,42,0,'accepted') ON CONFLICT(list_id,anilist_id) DO UPDATE SET planning_state='accepted'").run();
db.close();console.log("Synthetic 25-episode layout fixture ready");
