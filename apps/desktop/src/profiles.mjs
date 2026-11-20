import { readFile, writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serverUrl } from "./server-url.mjs";

/** Local-only registry. Never expose settings (encrypted device credentials) to a website. */
export class Profiles {
  constructor(directory) { this.directory=directory;this.file=join(directory,"host.json");this.data={version:2,activeId:null,profiles:[],draft:{step:"welcome"}};this.writes=Promise.resolve(); }
  async load() {
    await mkdir(this.directory,{recursive:true});
    let old;try{old=JSON.parse(await readFile(this.file,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;return;}
    if(old.version!==undefined&&old.version!==1&&old.version!==2)throw Error("Настройки созданы более новой версией приложения; файл сохранён");
    if(old.version===2){
      if(!Array.isArray(old.profiles)||old.profiles.some(p=>!/^[-a-z0-9]+$/i.test(p.id)||typeof p.origin!=="string"))throw Error("Повреждён список серверов; исходный файл сохранён");
      this.data=old;return;
    }
    // Preserve the original bytes, secret, default Electron session and legacy directories.
    await copyFile(this.file,this.file+".before-profiles");
    if(old.server){const p={id:randomUUID(),origin:old.server,name:new URL(old.server).host,legacy:true,settings:old,wizard:{step:"done"}};this.data.profiles=[p];this.data.activeId=p.id;}else this.data.legacySettings=old;
    await this.save();
  }
  get active(){return this.data.profiles.find(p=>p.id===this.data.activeId);}
  list(){return this.data.profiles.map(({id,origin,name})=>({id,origin,name,active:id===this.data.activeId}));}
  partition(p=this.active){return p&&!p.legacy?"persist:home-theater-"+p.id:undefined;}
  directoryFor(p=this.active){return p&&!p.legacy?join(this.directory,"profiles",p.id):this.directory;}
  ensure(origin,name){
    let p=this.data.profiles.find(p=>p.origin===origin);
    if(!p){p={id:randomUUID(),origin,name:(name||new URL(origin).host).slice(0,80),legacy:!this.data.profiles.length,settings:{...(!this.data.profiles.length?this.data.legacySettings:{}),server:origin},wizard:{step:"auth"}};this.data.profiles.push(p);}
    return p;
  }
  async save(){const bytes=JSON.stringify(this.data);this.writes=this.writes.catch(()=>{}).then(async()=>{await writeFile(this.file+".tmp",bytes,{mode:0o600});await rename(this.file+".tmp",this.file);});return this.writes;}
}

/** User input is forgiving; internal persisted origins still use strict serverUrl(). */
export function normalizeServerAddress(value,{development=false}={}){
  let address=String(value??"").trim();if(!address)throw Error("Укажите адрес сервера");
  if(address.startsWith("//"))address="https:"+address;
  else if(!/^[a-z][a-z\d+.-]*:\/\//i.test(address))address="https://"+address;
  const authority=address.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if(!authority||/\s/.test(authority))throw Error("Не удалось распознать адрес сервера");
  let u;try{u=new URL(address);}catch{throw Error("Не удалось распознать адрес сервера");}if(!["http:","https:"].includes(u.protocol)||u.hostname.includes("%"))throw Error("Не удалось распознать адрес сервера");
  const local=["localhost","127.0.0.1","[::1]"].includes(u.hostname);
  if(!(development&&local&&u.protocol==="http:"))u.protocol="https:";
  u.username="";u.password="";u.pathname="/";u.search="";u.hash="";
  return serverUrl(u.origin,{development});
}
