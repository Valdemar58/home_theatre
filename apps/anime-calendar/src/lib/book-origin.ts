// Выход книги в оригинале: статус трекеров по-русски («32 Volumes (Ongoing)» → «32 тома, выходит»).

const STATE: Record<string, string> = {
  ongoing: "выходит", complete: "завершена", completed: "завершена", hiatus: "перерыв", cancelled: "отменена",
  canceled: "отменена", discontinued: "прекращена", "side story": "побочная история", "side stories": "побочные истории",
};

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** Одна строка статуса MangaUpdates: «32 Volumes (Ongoing)» → «32 тома, выходит». Нераспознанное — как есть. */
function lineRu(line: string): string {
  const m = /^\s*(\d+)\+?\s*(volumes?|chapters?|vols?\.?|ch\.?)?\s*(?:\(([^)]+)\))?/i.exec(line);
  if (!m) return line.trim();
  const n = Number(m[1]);
  const unit = /^v/i.test(m[2] ?? "") ? plural(n, "том", "тома", "томов") : plural(n, "глава", "главы", "глав");
  const state = m[3] ? STATE[m[3].trim().toLowerCase()] ?? m[3].trim() : null;
  return `${n} ${unit}${state ? `, ${state}` : ""}`;
}

/** Статус MangaUpdates (бывает в несколько строк: основная серия и побочные) → по-русски, основная строка. */
export function muStatusRu(status: string | null): string | null {
  if (!status?.trim()) return null;
  const lines = status.split(/\n|<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lineRu(lines[0]) : null;
}

/** Последняя известная глава оригинала из статуса («150 Chapters» → 150; тома — null). */
export function muStatusChapters(status: string | null): number | null {
  const m = /(\d+)\s*chapters?/i.exec(status ?? "");
  return m ? Number(m[1]) : null;
}

/** Статус AniList → по-русски (если трекеров нет). */
export const ANILIST_STATUS_RU: Record<string, string> = {
  RELEASING: "выходит", FINISHED: "завершена", HIATUS: "перерыв", CANCELLED: "отменена", NOT_YET_RELEASED: "анонс",
};
