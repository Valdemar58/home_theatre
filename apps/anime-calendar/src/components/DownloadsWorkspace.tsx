"use client";
import { DesktopDownloads } from "./DesktopDownloads";

export function DownloadsWorkspace({admin,title,name}:{admin:boolean;title?:number;name?:string}) {
  return <div className="max-w-5xl space-y-5"><h1 className="text-2xl font-bold">Загрузки</h1><DesktopDownloads title={title} titleName={name}/></div>;
}
