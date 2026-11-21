// Real Electron + a deterministic, slow HTTP proxy. No VPN setting or real account is changed.
import {createServer} from "node:http";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url),electron=require("electron");
const index=process.argv.indexOf("--output"),output=resolve(index>=0?process.argv[index+1]:".local/proxy-network");
await mkdir(output,{recursive:true});const directory=await mkdtemp(join(output,"profile-")),report=join(directory,"result.json");
const origin="http://only-through-proxy.invalid",requests=[];
const proxy=createServer(async(req,res)=>{
  const u=new URL(req.url);assert.equal(u.origin,origin);
  requests.push({path:u.pathname,cookie:!!req.headers.cookie,auth:!!req.headers.authorization,method:req.method});
  if(u.pathname==="/api/desktop/info"){
    await new Promise(r=>setTimeout(r,180));res.setHeader("content-type","application/json");res.end(JSON.stringify({service:"home_theater",desktopProtocol:2}));
  }else if(u.pathname==="/api/desktop/commands"){res.setHeader("content-type","application/json");res.end('{"commands":[]}');}
  else {res.setHeader("content-type","text/html");res.end("<!doctype html><title>Proxy fixture</title><h1>Same profile</h1>");}
});
await new Promise(r=>proxy.listen(0,"127.0.0.1",r));
const networkModule=new URL("../src/server-network.mjs",import.meta.url).href,compatModule=new URL("../src/compatibility.mjs",import.meta.url).href;
const entry=join(directory,"entry.mjs");await writeFile(entry,`
import {app,session,BrowserWindow} from 'electron';import fs from 'node:fs';import {ServerNetwork} from ${JSON.stringify(networkModule)};import {ServerCompatibility} from ${JSON.stringify(compatModule)};
app.setPath('userData',${JSON.stringify(directory)});app.enableSandbox();
app.whenReady().then(async()=>{try{
  const origin=${JSON.stringify(origin)},s=session.fromPartition('persist:proxy-fixture');
  await s.setProxy({mode:'fixed_servers',proxyRules:${JSON.stringify("http://127.0.0.1:"+proxy.address().port)}});
  await s.cookies.set({url:origin,name:'fixture_account',value:'preserved',expirationDate:Math.floor(Date.now()/1000)+3600});
  const n=new ServerNetwork(()=>s),fetcher=(url,options)=>n.fetch(url,options);let blocked=false;
  try{await new ServerCompatibility(fetcher,{requestTimeout:50,getRoute:url=>n.route(url)}).ensure(origin);}catch(e){blocked=e.code==='SERVER_CONNECTION_TIMEOUT';}
  if(!blocked)throw Error('The short baseline budget must fail on a slow proxy');
  const states=[];await new ServerCompatibility(fetcher,{requestTimeout:3000,getRoute:url=>n.route(url),onState:(_url,state)=>states.push(state)}).ensure(origin);
  const r=await n.fetch(origin+'/api/desktop/commands',{credentials:'omit',headers:{Authorization:'Bearer fixture-only'}});if(r.status!==200)throw Error('Native command did not use the proxy');
  const w=new BrowserWindow({show:false,webPreferences:{session:s,sandbox:true,nodeIntegration:false,contextIsolation:true}});await w.loadURL(origin+'/');
  const cookies=await s.cookies.get({url:origin});
  fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:true,shortBudgetBlocked:blocked,slowProxyAccepted:true,route:await n.route(origin),profileCookiePreserved:cookies.some(c=>c.name==='fixture_account'),connectingReported:states.some(s=>s.phase==='connecting'&&s.route==='proxy'),validationReported:states.some(s=>s.phase==='validating')}));
}catch(e){fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({error:e.message}));process.exitCode=1;}finally{app.quit();}});
`);
let timer;
try{
  await new Promise((resolve,reject)=>{const child=spawn(electron,[entry],{stdio:"pipe",windowsHide:true});let errors="";child.stderr.on("data",b=>{errors=(errors+b.toString()).slice(-1000);});child.stdout.resume();timer=setTimeout(()=>{child.kill();reject(Error("Proxy test timed out"));},30000);child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(Error("Proxy test failed: "+errors)));});
  const result=JSON.parse(await readFile(report,"utf8"));assert.equal(result.error,undefined,result.error);assert(result.passed&&result.profileCookiePreserved);assert.equal(result.route,"proxy");
  const probes=requests.filter(r=>r.path==="/api/desktop/info");assert.equal(probes.length,2);assert(probes.every(r=>!r.cookie&&!r.auth&&r.method==="GET"));
  const commands=requests.filter(r=>r.path==="/api/desktop/commands");assert.equal(commands.length,1);assert(commands[0].auth&&!commands[0].cookie);assert(requests.some(r=>r.path==="/"&&r.cookie));
  const proof={...result,anonymousProbes:true,singleCommand:true,webAndNativeUseSameSession:true};await writeFile(join(output,"proxy-network-proof.json"),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{clearTimeout(timer);proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
