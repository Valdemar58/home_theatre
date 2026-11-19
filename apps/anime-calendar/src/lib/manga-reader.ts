export type MangaMode = "paged" | "strip";
export type MangaDir = "rtl" | "ltr";
export type MangaSettings = {
  mode: MangaMode; dir: MangaDir; fit: "height" | "width"; double: boolean; stripWidth: number;
  taps: "direction" | "physical" | "off"; swipe: boolean; keyboard: boolean; wheel: boolean;
  gap: number; background: "dark" | "black" | "light";
};
export const MANGA_DEFAULTS: MangaSettings = {
  mode: "paged", dir: "rtl", fit: "height", double: true, stripWidth: 48,
  taps: "direction", swipe: true, keyboard: true, wheel: true, gap: 0, background: "dark",
};
export function mangaSettings(value: Partial<MangaSettings>): MangaSettings {
  const s = { ...MANGA_DEFAULTS, ...value };
  for (const key of ["double", "swipe", "keyboard", "wheel"] as const) if (typeof s[key] !== "boolean") s[key] = MANGA_DEFAULTS[key];
  for (const [key, allowed] of Object.entries({ mode: ["paged", "strip"], dir: ["rtl", "ltr"], fit: ["height", "width"], taps: ["direction", "physical", "off"], background: ["dark", "black", "light"] })) {
    if (!allowed.includes(String(s[key as keyof MangaSettings]))) Object.assign(s, { [key]: MANGA_DEFAULTS[key as keyof MangaSettings] });
  }
  s.stripWidth = Number.isFinite(s.stripWidth) ? Math.max(24, Math.min(96, s.stripWidth)) : 48;
  s.gap = Number.isFinite(s.gap) ? Math.max(0, Math.min(32, s.gap)) : 0;
  return s;
}
export function tapAction(x: number, s: Pick<MangaSettings, "taps" | "dir">): "next" | "previous" | "controls" | null {
  if (x >= 0.3 && x <= 0.7) return "controls";
  if (s.taps === "off") return null;
  const nextOnLeft = s.taps === "direction" && s.dir === "rtl";
  return (x < 0.3) === nextOnLeft ? "next" : "previous";
}
export function mangaKey(key: string, shift: boolean, dir: MangaDir): "next" | "previous" | null {
  if (key === "ArrowLeft") return dir === "rtl" ? "next" : "previous";
  if (key === "ArrowRight") return dir === "rtl" ? "previous" : "next";
  if (key === "PageDown" || (key === " " && !shift)) return "next";
  if (key === "PageUp" || (key === " " && shift)) return "previous";
  return null;
}
