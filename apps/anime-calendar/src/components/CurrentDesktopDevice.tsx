"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ComputerDesktopIcon } from "@heroicons/react/24/outline";

type Binding={id:string|null;label?:string;status:string;active?:boolean;online?:boolean;error?:string|null};
type Bridge={deviceInfo:()=>Promise<Binding>;linkDevice:()=>Promise<Binding>;unlinkDevice:()=>Promise<Binding>;openLocalLibrary?:()=>void};
const bridge=()=>typeof window==='undefined'?undefined:(window as Window&{homeTheaterDesktop?:Bridge}).homeTheaterDesktop;
export function useCurrentDesktop(){
  const [desktop,setDesktop]=useState(false);
  useEffect(()=>setDesktop(!!bridge()),[]);
  const query=useQuery({queryKey:['current-desktop-device'],queryFn:()=>bridge()!.deviceInfo(),enabled:desktop,refetchInterval:10000,retry:false});
  useEffect(()=>{
    if(!desktop||!query.data)return;
    const id=query.data.active?query.data.id:null,previous=sessionStorage.getItem('home-theater-current-device');
    if(id){sessionStorage.setItem('home-theater-current-device',id);sessionStorage.setItem('home-theater-device',id);}
    else{sessionStorage.removeItem('home-theater-current-device');if(previous&&sessionStorage.getItem('home-theater-device')===previous)sessionStorage.removeItem('home-theater-device');}
    if(id!==previous)window.dispatchEvent(new Event('desktop-device-changed'));
  },[desktop,query.data]);
  return {desktop,...query};
}
export function CurrentDesktopDevice(){
  const current=useCurrentDesktop(),qc=useQueryClient(),path=usePathname();
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  if(!current.desktop)return null;
  const d=current.data;
  async function connect(){setBusy(true);setError(null);try{await bridge()!.linkDevice();await Promise.all([qc.invalidateQueries({queryKey:['current-desktop-device']}),qc.invalidateQueries({queryKey:['devices']}),qc.invalidateQueries({queryKey:['desktop-devices']}),qc.invalidateQueries({queryKey:['home']})]);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const status=!d?'Определяем устройство…':d.status==='other-account'?'Привязано к другому аккаунту':!d.active?'Не привязано':d.online?'Подключено':'Восстанавливаем соединение';
  return <section aria-label="Текущее устройство" className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-800 pb-3 text-xs text-gray-400">
    <Link href="/devices" className="flex min-w-0 items-center gap-2 rounded hover:text-gray-100"><ComputerDesktopIcon className="h-4 w-4 shrink-0"/><span className="truncate">{d?.label||'Этот компьютер'}</span></Link>
    <span role="status" className={d?.active&&d.online?'text-emerald-400':''}>{status}</span>
    {d&&!d.active&&d.status!=='other-account'&&<button disabled={busy||current.isFetching} onClick={()=>void connect()} className="rounded px-1 py-1 text-indigo-300 transition hover:bg-gray-800 hover:text-indigo-200 disabled:opacity-50">{busy?'Подключаем…':'Подключить'}</button>}
    {d?.status==='other-account'&&<Link href="/devices" className="text-indigo-300 hover:text-indigo-200">Управление привязкой</Link>}
    {path==='/devices'&&bridge()?.openLocalLibrary&&<button onClick={()=>bridge()?.openLocalLibrary?.()} className="ml-auto rounded px-1 py-1 transition hover:bg-gray-800 hover:text-gray-100">Подключить готовые файлы</button>}
    {(error||current.error||d?.error)&&<p role="alert" className="w-full text-amber-300">{error||(current.error as Error)?.message||d?.error}</p>}
  </section>;
}
