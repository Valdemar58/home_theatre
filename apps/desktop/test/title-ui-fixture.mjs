import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('apps/desktop/release/m6-data/anime-calendar.db');
const now=Math.floor(Date.now()/1000);
for(const r of db.prepare("SELECT key,value FROM cache WHERE key LIKE 'media:%42'").all()) {
 const v=JSON.parse(r.value); if(v.id!==42)continue;
 Object.assign(v,{startDate:{year:2026,month:9,day:1},endDate:{year:null,month:null,day:null},popularity:1234,studios:['Тестовая студия'],genres:['Adventure'],description:'Синтетический тайтл для проверки интерфейса. Герои отправляются в путешествие и постепенно открывают мир вокруг себя. Эти данные используются только в изолированной проверке.',countryOfOrigin:'JP',source:'MANGA'});
 db.prepare('UPDATE cache SET value=?,expires_at=? WHERE key=?').run(JSON.stringify(v),now+86400,r.key);
}
db.close();
