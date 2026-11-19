import type { Block } from "./books";

// Автоперевод главы ранобэ (TASKS 5.7): глава режется на куски по абзацам (картинки и разделители остаются на своих
// местах), куски переводятся по порядку, перевод собирается обратно в блоки ридера.

export type Segment = { t: "text"; paras: string[] } | { t: "keep"; block: Block };

/** Куски главы: абзацы подряд — до max символов, картинка и разделитель — отдельно (не переводятся). */
export function segments(blocks: Block[], max = 4000): Segment[] {
  const out: Segment[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length) out.push({ t: "text", paras: cur });
    cur = [];
    len = 0;
  };
  for (const b of blocks) {
    if (b.t !== "p") {
      flush();
      out.push({ t: "keep", block: b });
      continue;
    }
    const s = b.text.trim();
    if (!s) continue;
    if (len && len + s.length > max) flush();
    cur.push(s);
    len += s.length + 2;
  }
  flush();
  return out;
}

/** Перевод кусков → блоки ридера (абзацы перевода — по пустым строкам; одна строка без пустых — по переводам строк). */
export function assemble(segs: Segment[], translated: string[]): Block[] {
  const out: Block[] = [];
  let k = 0;
  for (const s of segs) {
    if (s.t === "keep") { out.push(s.block); continue; }
    const text = (translated[k++] ?? "").trim();
    const paras = (/\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split(/\n/)).map((p) => p.trim()).filter(Boolean);
    for (const p of paras) out.push({ t: "p", text: p });
  }
  return out;
}

/** Глава ИИ в оглавлении: cref = «издание|ключ главы» (провайдер «ai»). */
export const aiCref = (edition: string, key: string) => `${edition}|${key}`;
export const parseAiCref = (cref: string) => {
  const i = cref.indexOf("|");
  return { edition: cref.slice(0, i), key: cref.slice(i + 1) };
};
