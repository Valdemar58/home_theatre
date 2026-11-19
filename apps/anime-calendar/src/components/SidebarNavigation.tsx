"use client";
import Link from "next/link";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

export type SidebarItem = { href: string; label: string; icon: React.ComponentType<{className?: string}>; active?: boolean; external?: boolean; group?: string; badge?: number };

/** Reserve one row for overflow instead of letting a scrollbar squeeze the icon rail. */
export function SidebarNavigation({items,labelClass,onOpenChange}:{items:SidebarItem[];labelClass:string;onOpenChange:(open:boolean)=>void}) {
  const root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null);
  const [slots,setSlots]=useState(1),[open,setOpen]=useState(false);
  useEffect(()=>onOpenChange(open),[open,onOpenChange]);
  useEffect(()=>{
    const el=root.current;if(!el)return;
    const measure=()=>setSlots(Math.max(1,Math.floor(el.clientHeight/48)));
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){setOpen(false);trigger.current?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[open]);
  const count=items.length>slots?Math.max(0,slots-1):items.length;
  const overflow=items.slice(count);
  const itemLink=(item:SidebarItem,popup=false)=>{
    const Icon=item.icon;
    const body=<><span className="relative shrink-0"><Icon className="h-6 w-6"/>{!!item.badge&&<span className="absolute -right-1 -top-1 rounded-full bg-indigo-500 px-1 text-[10px] leading-4 text-white">{item.badge}</span>}</span><span className={cx("whitespace-nowrap transition-opacity duration-150",!popup&&labelClass)}>{item.label}</span></>;
    const className=cx("flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent-300",item.active?"tone-accent solid":"text-gray-300 hover:bg-gray-700/60 hover:text-white");
    return item.external?<a key={item.href} href={item.href} title={item.label} className={className} target="_blank" rel="noreferrer" onClick={()=>setOpen(false)}>{body}</a>:<Link key={item.href} href={item.href} title={item.label} aria-current={item.active?"page":undefined} className={className} onClick={()=>setOpen(false)}>{body}</Link>;
  };
  return <div ref={root} className="relative mt-4 min-h-0 flex-1">
    <nav aria-label="Разделы" className="h-full space-y-1 overflow-hidden px-2">
      {items.slice(0,count).map(i=>itemLink(i))}
      {!!overflow.length&&<button ref={trigger} type="button" aria-label="Ещё" aria-expanded={open} aria-controls="sidebar-overflow" onClick={()=>setOpen(!open)} className={cx("flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm focus-visible:outline-2 focus-visible:outline-accent-300",open||overflow.some(i=>i.active)?"tone-accent soft":"text-gray-300 hover:bg-gray-700/60")}><EllipsisHorizontalIcon className="h-6 w-6 shrink-0"/><span className={cx("transition-opacity duration-150",labelClass)}>Ещё</span></button>}
    </nav>
    {open&&!!overflow.length&&<nav id="sidebar-overflow" aria-label="Дополнительные разделы" className="absolute bottom-0 left-full ml-2 max-h-[min(32rem,calc(100dvh-10rem))] w-64 overflow-y-auto overscroll-contain rounded-xl bg-gray-800 p-2 shadow-xl ring-1 ring-gray-600">
      {overflow.map((item,i)=><div key={item.href}>{item.group!==overflow[i-1]?.group&&item.group&&<p className="px-3 pb-1 pt-3 text-xs text-gray-400">{item.group}</p>}{itemLink(item,true)}</div>)}
    </nav>}
  </div>;
}
