import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
const exec=promisify(execFile);
const identity=value=>"volume-"+createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0,32);

export function windowsVolumes(value) {
  return (Array.isArray(value)?value:value?[value]:[]).filter(v=>/^[a-z]:$/i.test(v.DriveLetter)&&v.DeviceID).map(v=>({id:identity(v.DeviceID),label:v.Label?`${v.DriveLetter} · ${v.Label}`:v.DriveLetter,root:v.DriveLetter+"\\"}));
}
export function linuxVolumes(value) {
  const all=[];const visit=v=>{all.push(v);for(const child of v.children??[])visit(child);};
  for(const v of value.blockdevices??[])visit(v);
  const seen=new Set();
  return all.flatMap(v=>{
    const roots=(v.mountpoints??[v.mountpoint]).filter(p=>typeof p==="string"&&p.startsWith("/")&&!p.startsWith("/boot")&&!p.startsWith("/snap/"));
    if(!v.uuid||v.ro||!roots.length||seen.has(v.uuid)||v.type==="loop")return [];
    seen.add(v.uuid);const root=roots.sort((a,b)=>a.length-b.length)[0];
    return [{id:identity(v.uuid),root,label:v.label||(root==="/"?"Системный том":path.posix.basename(root))}];
  });
}
/** Mounted local filesystems only; never mount, unlock or elevate on the user's behalf. */
export async function detectVolumes() {
  let entries;
  if(process.platform==="win32") {
    const binary=path.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const {stdout}=await exec(binary,["-NoProfile","-NonInteractive","-Command","Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -and ($_.DriveType -eq 2 -or $_.DriveType -eq 3) } | Select-Object DeviceID,DriveLetter,Label | ConvertTo-Json -Compress"],{windowsHide:true,timeout:12000,maxBuffer:1024*1024});
    entries=windowsVolumes(JSON.parse(stdout.replace(/^\uFEFF/,"")));
  }else {
    const {stdout}=await exec("lsblk",["--json","--bytes","--output","NAME,TYPE,MOUNTPOINTS,UUID,LABEL,RO"],{timeout:10000,maxBuffer:1024*1024});
    entries=linuxVolumes(JSON.parse(stdout));
  }
  return Promise.all(entries.map(async v=>{try{const [s,f]=await Promise.all([stat(v.root),statfs(v.root)]);return {...v,dev:String(s.dev),total:f.blocks*f.bsize,free:f.bavail*f.bsize,online:true};}catch{return {...v,total:0,free:0,online:false};}}));
}
export function volumeFor(folder,volumes) {
  return [...volumes].sort((a,b)=>b.root.length-a.root.length).find(v=>{const relative=path.relative(v.root,path.resolve(folder));return !relative||(!relative.startsWith("..")&&!path.isAbsolute(relative));});
}
