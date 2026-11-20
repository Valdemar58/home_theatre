// Browser-only visual fixture for the real renderer. No account, file or network operations.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const bridge=`
const scenario=new URLSearchParams(location.search).get('scenario')||'fresh';
const s={product:{name:'home_theater',server:{name:'Пивосинема',origin:'https://cinema.example'}},profiles:[{id:'one',name:'Пивосинема',origin:'https://cinema.example'},{id:'two',name:'Разработка',origin:'https://dev.example'}],active:'one',server:'https://cinema.example',step:({fresh:'welcome',password:'auth',register:'auth',waiting:'access',blocked:'access',links:'links',import:'links',server:'server'})[scenario]||'welcome',linked:false,secureStorage:true,signedIn:!['fresh','server','password','register'].includes(scenario),access:['links','import'].includes(scenario)?'approved':scenario==='blocked'?'blocked':'pending'};
window.fixture=s;
window.host={call:async(action,data={})=>{
if(action==='setup-state')return structuredClone(s);
if(action==='setup-step'){s.step=data.step;return;}
if(action==='setup-probe'){await new Promise(r=>setTimeout(r,900));if(data.address.includes('invalid'))throw Error('Сервер не отвечает. Проверьте адрес или соединение.');if(data.address.includes('other'))throw Error('Это другой сервис. Совместимый API не найден.');return{origin:'https://cinema.example',name:'Пивосинема'};}
if(action==='setup-connect')return{step:'auth'};
if(action==='setup-auth'){if(scenario==='password')throw Error('Неверный логин или пароль');s.signedIn=true;s.access=data.register?'pending':'approved';return{access:s.access};}
if(action==='setup-status')return s.signedIn?{access:s.access}:null;
if(action==='setup-invite'){if(data.token==='used')throw Error('Это приглашение уже использовано');s.access='approved';return{ok:true};}
if(action==='setup-me')return{shikimori:{configured:true,linked:scenario==='import'}};
if(action==='setup-binding'){if(data.link)s.linked=true;return{active:s.linked};}
if(action==='setup-lists')return[];
if(action==='setup-import')throw Error('Shikimori не отвечает. Основные данные сохранены.');
return{};
}};`;
export function serveOnboarding(port=5077){return createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),name=url.pathname.slice(1)||'onboarding.html';
 if(name==='fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bridge);return;}
 if(!['onboarding.html','onboarding.js','onboarding.css','server-picker.js'].includes(name)){res.writeHead(404);res.end();return;}
 let text=await readFile(new URL('../src/'+name,import.meta.url),'utf8');
 if(name==='onboarding.html')text=text.replace('<script type="module"','<script src="fixture.js"></script><script type="module"');
 res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(text);
}).listen(port,'127.0.0.1');}
if(process.argv[1]?.endsWith('onboarding-ui-fixture.mjs'))serveOnboarding();
