// Пересказы глав манги с вики Fandom (TASKS 5.11б): номер главы — из инфобокса (title / chapter / number),
// текст — раздел «Summary / Plot / Synopsis» в простом виде. Чистые функции — для тестов.

/** Вики-разметка → простой текст: без картинок, шаблонов, ссылок, сносок и оформления. */
export function plainWiki(s: string): string {
  return s
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\[\[(?:File|Image|Файл):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const SECTION = /^==\s*(summary|plot|plot summary|synopsis|story)\s*==\s*$/gim;

/** Номер главы и пересказ по странице главы (null — не глава или пересказа нет). */
export function fandomChapter(wikitext: string): { num: number; text: string } | null {
  const box = wikitext.match(/\{\{\s*Infobox[\s\S]*?\n\}\}/i)?.[0] ?? "";
  const field = (k: string) => box.match(new RegExp(`^\\|\\s*${k}\\s*=\\s*(.*)$`, "im"))?.[1] ?? "";
  const num = Number((field("chapter") || field("number") || field("title")).match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Самый длинный из разделов-пересказов («Synopsis» часто пустой: «Information to be added»)
  const parts: string[] = [];
  const heads = [...wikitext.matchAll(SECTION)];
  for (const h of heads) {
    const start = h.index! + h[0].length;
    const rest = wikitext.slice(start);
    const end = rest.search(/^==[^=]/m);
    parts.push(plainWiki(end >= 0 ? rest.slice(0, end) : rest));
  }
  const text = parts.filter((p) => p.length > 80 && !/^information to be added/i.test(p)).sort((a, b) => b.length - a.length)[0];
  return text ? { num, text } : null;
}
