// Slow release gate. Real per-user NSIS updates, with a unique test App ID and no real server.
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {mkdir,mkdtemp,readFile,writeFile,cp,symlink,readdir,access,stat} from "node:fs/promises";
import {createWriteStream} from "node:fs";
import {spawn,execFileSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";

if(process.platform!=="win32"){console.log("Installed NSIS update gate runs on Windows");process.exit(0);}
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),".."),repository=resolve(desktop,"../..");
const require=createRequire(join(desktop,"package.json")),yaml=createRequire(require.resolve("electron-updater"))("js-yaml");
const builder=require.resolve("electron-builder/out/cli/cli.js"),electronDist=dirname(require("electron"));
const outputArg=process.argv.indexOf("--output"),output=resolve(outputArg>=0?process.argv[outputArg+1]:join(repository,".local/installed-updates"));
await mkdir(output,{recursive:true});const root=await mkdtemp(join(output,"proof-"));
assert(root.startsWith(output));
const nonce=randomBytes(4).toString("hex"),name="home_theater_update_check_"+nonce,applicationId="org.hometheater.desktop.update-check-"+nonce;
const current="0.5.0-rc.12",target="0.5.0-rc.16",install=join(root,"installed"),userdata=join(root,"userdata"),appdata=join(root,"appdata"),resultFile=join(root,"result.json"),trace=join(root,"trace.jsonl"),retryFile=join(root,"retry");
const api=[],requests=[];let corrupt=true,assetRoot,metadata,initial;
const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,"http://localhost");requests.push(url.pathname);await writeFile(join(root,"requests.json"),JSON.stringify({requests,api}));
  if(url.pathname.startsWith("/updates/")){
    if(!metadata){res.writeHead(503);res.end();return;}
    if(url.pathname.endsWith("preview.yml")){res.setHeader("content-type","application/yaml");res.end(yaml.dump(metadata));return;}
    const name=decodeURIComponent(url.pathname.split("/").at(-1));assert(name&&!/[\\/]/.test(name));
    let bytes=await readFile(join(assetRoot,name));if(corrupt&&name.endsWith(".exe")){bytes=Buffer.from(bytes);bytes[bytes.length-1]^=1;}
    res.setHeader("content-length",bytes.length);res.end(bytes);return;
  }
  if(url.pathname.startsWith("/api/")){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||"{}");
    api.push({path:url.pathname,version:req.headers["x-proof-version"],action:body.action,cookie:!!req.headers.cookie});await writeFile(join(root,"requests.json"),JSON.stringify({requests,api}));res.setHeader("content-type","application/json");
    if(url.pathname==="/api/desktop/binding"){res.end(JSON.stringify({id:"0123456789abcdef01234567",status:"linked",tokenMatches:true}));return;}
    if(url.pathname==="/api/desktop/host"){res.end(JSON.stringify({deviceId:"0123456789abcdef01234567",rooms:[],grants:[]}));return;}
    if(url.pathname==="/api/desktop/transport"){res.end('{"streams":[],"jobs":[]}');return;}
    if(url.pathname==="/api/desktop/commands"){res.end('{"commands":[]}');return;}
    res.writeHead(404);res.end('{"error":"Unknown API"}');return;
  }
  res.setHeader("content-type","text/html; charset=utf-8");res.end("<!doctype html><title>Update proof</title><h1>Latest desktop connected</h1>");
}catch{res.writeHead(500);res.end("Fixture error");}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${server.address().port}`,feed=origin+"/updates/";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await pause(200);}throw Error("Installed update timed out; inspect "+root);}
async function run(command,args,log){const file=createWriteStream(log);await new Promise((resolve,reject)=>{const p=spawn(command,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});p.stdout.pipe(file);p.stderr.pipe(file);p.on("error",reject);p.on("exit",code=>code===0?resolve():reject(Error(`Process failed (${code}); inspect ${log}`)));});file.end();}
const ps=value=>"'"+value.replaceAll("'","''")+"'";
function stopInstalled(){if(!resolve(install).startsWith(root))throw Error("Unsafe cleanup target");const exe=join(install,name+".exe");execFileSync("powershell.exe",["-NoProfile","-Command",`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${ps(exe)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`],{windowsHide:true});}

async function build(version,label){
  const directory=join(root,label);await mkdir(directory,{recursive:true});await cp(join(desktop,"src"),join(directory,"src"),{recursive:true});
  await symlink(join(desktop,"node_modules"),join(directory,"node_modules"),"junction");
  const pkg=JSON.parse(await readFile(join(desktop,"package.json"),"utf8"));pkg.name=name;pkg.version=version;pkg.main="test-entry.mjs";pkg.build={...pkg.build,appId:applicationId,productName:name,publish:[{provider:"generic",url:feed}],files:["src/**/*","test-entry.mjs","package.json"],directories:{output:join(directory,"out")},artifactName:"test-${version}-${os}-${arch}.${ext}"};
  await writeFile(join(directory,"package.json"),JSON.stringify(pkg));
  await writeFile(join(directory,"test-entry.mjs"),`import {app,session,safeStorage,webContents} from "electron";import fs from "node:fs";import path from "node:path";import {StartupUpdates} from "./src/updates.mjs";
const user=${JSON.stringify(userdata)},data=${JSON.stringify(appdata)},result=${JSON.stringify(resultFile)},origin=${JSON.stringify(origin)};fs.mkdirSync(user,{recursive:true});fs.mkdirSync(data,{recursive:true});app.setPath("userData",user);app.setPath("appData",data);
let activeUpdater;const original=StartupUpdates.prototype.publish;StartupUpdates.prototype.publish=function(fields){activeUpdater=this;const r=original.call(this,fields);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({version:app.getVersion(),status:this.state.status,code:this.state.code})+"\\n");return r;};
app.once("ready",()=>{const host=path.join(user,"host.json");if(!fs.existsSync(host)){fs.mkdirSync(path.join(user,"downloads"),{recursive:true});fs.mkdirSync(path.join(user,"media"),{recursive:true});fs.mkdirSync(path.join(data,"home_theater-device"),{recursive:true});fs.writeFileSync(path.join(data,"home_theater-device","installation.key"),"e".repeat(64));fs.writeFileSync(path.join(user,"media","keep.bin"),"media must survive");fs.writeFileSync(path.join(user,"downloads","downloads.json"),JSON.stringify([{id:"preserved-job",title:1,titleName:"Fixture",state:"paused",files:[],selected:[],autoPrepare:false}]));fs.writeFileSync(host,JSON.stringify({version:2,activeId:"stable",profiles:[{id:"stable",origin,name:"Fixture",legacy:true,wizard:{step:"done"},settings:{server:origin,approved:true,deviceId:"0123456789abcdef01234567",secret:safeStorage.encryptString("f".repeat(64)).toString("base64"),downloadFolder:path.join(user,"media"),custom:"preserve"}}],draft:{step:"welcome"}}));void session.defaultSession.cookies.set({url:origin,name:"fixture_session",value:"retained",httpOnly:true,expirationDate:Math.floor(Date.now()/1000)+86400}).then(()=>session.defaultSession.cookies.flushStore());}session.defaultSession.webRequest.onBeforeSendHeaders({urls:[origin+"/*"]},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,"X-Proof-Version":app.getVersion()}}));});
let reported=false;
process.on("uncaughtExceptionMonitor",e=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({version:app.getVersion(),exception:e.message})+"\\n"));
async function report(){if(reported)return;reported=true;try{const h=JSON.parse(fs.readFileSync(path.join(user,"host.json"),"utf8")),p=h.profiles[0],cookies=await session.defaultSession.cookies.get({url:origin});fs.writeFileSync(result,JSON.stringify({version:app.getVersion(),profileId:h.activeId,deviceId:p.settings.deviceId,secretPreserved:safeStorage.decryptString(Buffer.from(p.settings.secret,"base64"))==="f".repeat(64),custom:p.settings.custom,cookiePreserved:cookies.some(c=>c.name==="fixture_session"&&c.value==="retained"),mediaPreserved:fs.readFileSync(path.join(user,"media","keep.bin"),"utf8")==="media must survive",jobs:JSON.parse(fs.readFileSync(path.join(user,"downloads","downloads.json"),"utf8"))}));}catch(e){fs.writeFileSync(result,JSON.stringify({version:app.getVersion(),error:e.message}));}finally{app.quit();}}
app.once("ready",()=>{let retried=false;setInterval(()=>{if(!retried&&activeUpdater?.state.status==="error"&&fs.existsSync(${JSON.stringify(retryFile)})){retried=true;void activeUpdater.run({retry:true});}const contents=webContents.getAllWebContents().filter(c=>!c.isDestroyed());fs.writeFileSync(path.join(user,"view-state.json"),JSON.stringify(contents.map(c=>({url:c.getURL(),loading:c.isLoadingMainFrame()}))));if(contents.some(c=>{try{const u=new URL(c.getURL());return u.origin===origin&&u.pathname==="/"&&!c.isLoadingMainFrame();}catch{return false;}}))void report();},500).unref();});
await import("./src/main.mjs");`);
  await run(process.execPath,[builder,"build","--projectDir",directory,"--win","nsis","--x64","--publish","never","--config.electronDist="+electronDist],join(root,label+"-build.log"));
  return {directory,out:join(directory,"out"),installer:join(directory,"out",`test-${version}-win-x64.exe`)};
}

try{
  console.log("Building isolated older and latest NSIS packages");const old=await build(current,"old"),latest=await build(target,"new");assetRoot=latest.out;
  const candidates=await readdir(latest.out);for(const name of candidates.filter(n=>n.endsWith(".yml"))){const m=yaml.load(await readFile(join(latest.out,name),"utf8"));if(m?.version===target&&m.files)metadata=m;}
  assert(metadata,"Installer metadata generated");
  await run(old.installer,["/S","/D="+install],join(root,"initial-install.log"));initial=spawn(join(install,name+".exe"),[],{stdio:"ignore",windowsHide:true});
  console.log("Checking corrupt-package barrier");await waitFor(async()=>{try{return /ERR_(UPDATER_)?CHECKSUM_MISMATCH/.test(await readFile(trace,"utf8"));}catch{return false;}});
  assert.equal(api.length,0,"Old desktop must never access server APIs before a verified update");assert.equal(await access(resultFile).then(()=>true,()=>false),false);
  corrupt=false;await writeFile(retryFile,"retry");
  console.log("Installing latest directly and checking retained identity");
  const result=await waitFor(async()=>{try{return JSON.parse(await readFile(resultFile,"utf8"));}catch{return null;}});
  assert.equal(result.error,undefined,result.error);assert.equal(result.version,target);assert.equal(result.profileId,"stable");assert.equal(result.deviceId,"0123456789abcdef01234567");assert.equal(result.custom,"preserve");assert(result.secretPreserved&&result.cookiePreserved&&result.mediaPreserved);assert.equal(result.jobs[0].id,"preserved-job");assert.equal(result.jobs[0].state,"paused");
  assert(api.length>0);assert(api.every(r=>r.version===target),"Only latest desktop may contact server APIs");assert(!api.some(r=>r.action==="link"),"Update cannot create another device binding");
  const states=(await readFile(trace,"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert(states.some(s=>s.version===current&&s.status==="installing"));assert(states.some(s=>s.version===target&&s.status==="ready"));
  const report={passed:true,from:current,to:target,directLatest:true,checksumFailureBlocked:true,oldApiRequests:0,onlyLatestConnected:true,profilePreserved:true,cookiePreserved:true,devicePreserved:true,secretPreserved:true,jobsPreserved:true,mediaPreserved:true};
  await writeFile(join(output,"installed-update-proof.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  stopInstalled();const names=await readdir(install).catch(()=>[]),uninstaller=names.find(n=>/^Uninstall.*\.exe$/i.test(n));
  if(uninstaller)await run(join(install,uninstaller),["/S"],join(root,"uninstall.log")).catch(()=>{});
  server.closeAllConnections();await new Promise(r=>server.close(r));
}
