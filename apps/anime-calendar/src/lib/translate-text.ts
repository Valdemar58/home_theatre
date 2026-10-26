// Чистые правила перевода пересказов: нарезка по абзацам и словарь имён, которые встречаются в тексте.

/** Куски по целым абзацам, не длиннее max символов (абзац длиннее — режется по предложениям). */
export function chunkText(text: string, max = 5000): string[] {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }
    let cur = "";
    for (const s of p.match(/[^.!?。！？]+[.!?。！？]+["”」』)]*\s*|[^.!?。！？]+$/g) ?? [p]) {
      if (cur && cur.length + s.length > max) { pieces.push(cur.trim()); cur = ""; }
      cur += s;
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const out: string[] = [];
  for (const p of pieces) {
    if (out.length && out[out.length - 1].length + p.length + 2 <= max) out[out.length - 1] += `\n\n${p}`;
    else out.push(p);
  }
  return out;
}

export type GlossaryEntry = { names: string[]; ru: string };

const words = (s: string) => s.split(/[\s=・＝·.,'"-]+/).filter((w) => w.length >= 3);

/**
 * Пары «имя → по-русски», чьё имя (или его часть — «Subaru» из «Subaru Natsuki») встречается в тексте.
 * Части имени длиной от 3 символов, сравнение по целому слову.
 */
export function glossaryFor(text: string, entries: GlossaryEntry[], limit = 60): string[] {
  const lower = text.toLowerCase();
  const has = (w: string) => {
    const i = lower.indexOf(w.toLowerCase());
    if (i < 0) return false;
    // Японский — без пробелов между словами, достаточно вхождения
    if (/[぀-ヿ一-鿿]/.test(w)) return true;
    const re = new RegExp(`(?<![\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u");
    return re.test(lower);
  };
  const out: string[] = [];
  for (const e of entries) {
    const hit = e.names.some((n) => has(n) || words(n).some(has));
    if (hit) out.push(`${e.names.filter(Boolean).join(" / ")} = ${e.ru}`);
    if (out.length >= limit) break;
  }
  return out;
}
