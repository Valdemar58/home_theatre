// Isolated synthetic database only; no production access.
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const db=new DatabaseSync(fileURLToPath(new URL('../release/m6-data/anime-calendar.db',import.meta.url))), now=Math.floor(Date.now()/1000);
const media=JSON.parse(db.prepare('SELECT json FROM media WHERE anilist_id=42').get().json);
media.episodes=12;media.status='RELEASING';media.nextAiringEpisode={episode:11,airingAt:now+86400};
db.prepare('UPDATE media SET json=?,updated_at=? WHERE anilist_id=42').run(JSON.stringify(media),now);
const keys=db.prepare("SELECT key,value FROM cache WHERE key LIKE '%42%' AND (key LIKE '%detail%' OR key LIKE 'anilist:%' OR key LIKE 'media:%')").all();
for(const row of keys){try{let v=JSON.parse(row.value);if(v.id===42){v.episodes=12;v.status='RELEASING';v.nextAiringEpisode=media.nextAiringEpisode;v.schedule=[media.nextAiringEpisode];db.prepare('UPDATE cache SET value=?,expires_at=? WHERE key=?').run(JSON.stringify(v),now+86400,row.key);}}catch{}}
db.prepare("UPDATE watch_room_members SET status='left' WHERE user_id=1").run();
const episodes=Array.from({length:12},(_,i)=>({number:i+1,title:`Тестовое название ${i+1}`,overview:`Краткое описание серии ${i+1}. Герои обсуждают планы и готовятся к следующему путешествию.`,lang:"ru",airDate:null,still:null}));
db.prepare("INSERT INTO cache(key,value,expires_at,class) VALUES(?,?,?,'entity') ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at").run('plot-eps:v3:42',JSON.stringify({episodes,overview:null,source:'TMDB'}),now+86400);
db.prepare("INSERT OR REPLACE INTO friendships(from_id,to_id,status,created_at) VALUES(1,2,'accepted',?)").run(now);
const add=db.prepare('INSERT OR REPLACE INTO comments(id,anilist_id,user_id,parent_id,body,spoiler,episode,created_at,deleted) VALUES(?,42,?,?,?,0,1,?,0)');
for(let i=0;i<26;i++)add.run(50000+i,i%2+1,null,`Тестовый комментарий ${i+1}. Обсуждаем темп серии и выбранную озвучку.`,now-100+i);
for(let i=0;i<8;i++)add.run(50100+i,i%2+1,i===0?50025:50099+i,`Ответ уровня ${i+1}: продолжаем ту же ветку обсуждения.`,now+i);
db.close();console.log('Player fixture ready');
