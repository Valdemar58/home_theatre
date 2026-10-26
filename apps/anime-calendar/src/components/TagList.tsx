"use client";
import { useTagLabel } from "@/lib/client";

/** Теги AniList через запятую: по-русски, оригинал — при наведении. */
export function TagList({ names }: { names: string[] }) {
  const label = useTagLabel();
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>{i > 0 && ", "}<span title={n}>{label(n)}</span></span>
      ))}
    </>
  );
}
