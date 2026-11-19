// Visual-only fixture: real desktop HTML/CSS/renderer, synthetic IPC data.
// Not evidence of torrent or native functionality. Loopback only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = [1, 2, 3].map((ep, index) => ({ index, path: `Synthetic season/Synthetic S01E0${ep}.mp4`, name: `Synthetic S01E0${ep}.mp4`, bytes: 30858537, video: true, episode: ep, selected: ep !== 2, downloaded: 30858537, prepareState: "ready", prepareProgress: 1 }));
const job = { id: "visual", title: 42, titleName: "Тестовый сезон", releaseName: "Synthetic season · 3 серии · локальный тест", state: "ready", files, autoPrepare: true };
const state = { server: "https://cinema.example", linked: true, persistent: true, importProgress: null, rooms: [{id:1,name:"Комната друзей"}], grants:[{groupId:1,anilistId:42}], downloadFolder:"D:/Anime", downloads: [job], files: files.filter(f=>f.selected).map(f=>({...f,id:String(f.index),title:42,titleName:job.titleName,ep:f.episode,state:"ready",progress:1})) };
const bridge = `const s=${JSON.stringify(state)}; window.host={call:async(action,data)=>{if(action==='state') return s;if(action==='search')return [{id:42,title:'Тестовый сезон'}];if(action==='releases')return {releases:[{id:'visual',title:'Synthetic season · 3 серии · локальный тест',size:92575611,seeders:3,indexer:'Тестовый индексатор'}]};if(action==='download-inspect'){const j=structuredClone(s.downloads[0]);j.state='selecting';return j;}if(action==='download-start'){s.downloads[0].state='downloading';s.downloads[0].files.forEach(f=>{f.selected=data.selections.some(x=>x.index===f.index);f.downloaded=f.bytes*.4;f.prepareProgress=0;f.prepareState='imported'});return true;}return []}};`;
createServer(async(req,res)=>{
  const name = new URL(req.url,'http://localhost').pathname.slice(1) || 'index.html';
  if(name==='bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(bridge + `const visualCall=window.host.call;window.host.call=async(a,d)=>{if(a==='download-start'&&location.search.includes('fail'))throw new Error('Недостаточно места для выбранных серий. Выберите другую папку.');return visualCall(a,d)};`);return;}
  if(!['index.html','style.css','renderer.js'].includes(name)){res.writeHead(404);res.end();return;}
  let body=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
  if(name==='index.html') body=body.replace('<script src="renderer.js">','<script src="bridge.js"></script><script src="renderer.js">').replace('<script src="stream-provider.js"></script>','');
  res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html');res.end(body);
}).listen(5063,'127.0.0.1');
