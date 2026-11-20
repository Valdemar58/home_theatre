"use client";
import { useState } from "react";
import { DesktopDownloads } from "./DesktopDownloads";
import { DownloadsView } from "./DownloadsView";

export function DownloadsWorkspace({admin,title,name}:{admin:boolean;title?:number;name?:string}) {
  const [place,setPlace]=useState("desktop");
  return <div className="max-w-5xl space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">Загрузки</h1>{admin&&<label className="flex items-center gap-3 text-sm text-gray-400">Хранилище<select aria-label="Хранилище" className="min-h-11 max-w-full rounded-lg bg-gray-800 px-3 text-gray-100 ring-1 ring-gray-600" value={place} onChange={e=>setPlace(e.target.value)}><option value="desktop">Мой компьютер</option><option value="server">Медиасервер</option></select></label>}</div>{place==="desktop"?<DesktopDownloads title={title} titleName={name}/>:<DownloadsView/>}</div>;
}
