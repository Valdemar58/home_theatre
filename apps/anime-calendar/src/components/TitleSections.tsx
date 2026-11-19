"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { activeTitleSection } from "@/lib/title-section";

export type TitleSection = { id: string; label: string };

/** A table of contents, not tabs: every section stays in the document. */
export function TitleSections({ sections }: { sections: TitleSection[] }) {
  const [active, setActive] = useState(sections[0]?.id);
  const nav = useRef<HTMLElement>(null);
  const key = sections.map(s => s.id).join("|");
  useEffect(() => {
    const ids = key.split("|");
    let frame = 0;
    const update = () => {
      frame = 0;
      const nodes = ids.map(id => document.getElementById(id)).filter((n): n is HTMLElement => !!n);
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      const current = activeTitleSection(nodes.map(n => ({ id: n.id, top: n.getBoundingClientRect().top })), window.innerWidth < 768 ? 208 : 160, atBottom);
      if (current) setActive(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    ids.forEach(id => { const node = document.getElementById(id); if (node) resize.observe(node); });
    update();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [key]);
  useEffect(() => {
    const element = nav.current;
    const link = element?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!element || !link || window.innerWidth >= 1024) return;
    element.scrollTo({ left: link.offsetLeft - element.offsetLeft - (element.clientWidth - link.offsetWidth) / 2,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [active]);
  const selected = Math.max(0, sections.findIndex(s => s.id === active));
  return <nav ref={nav} aria-label="Разделы тайтла" className="title-drum" style={{ "--active-section": selected } as CSSProperties}>
    <span className="title-drum-rail" aria-hidden="true"><span /></span>
    {sections.map((section, index) => <a key={section.id} href={`#${section.id}`}
      aria-current={active === section.id ? "location" : undefined}
      style={{ "--distance": Math.min(3, Math.abs(index - selected)), "--drum-angle": `${Math.max(-3, Math.min(3, index - selected)) * -8}deg` } as CSSProperties}
      onClick={event => {
        const node = document.getElementById(section.id);
        if (!node) return;
        event.preventDefault();
        setActive(section.id);
        history.replaceState(null, "", `#${section.id}`);
        node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
        node.focus({ preventScroll: true });
      }}>{section.label}</a>)}
  </nav>;
}
