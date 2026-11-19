// Общие правила источников: идентичность моста остаётся стабильной для сохранённого прогресса.
export type BookSourceState = {
  provider: string; sourceId: string; name: string; lang: string | null;
  status: "searching" | "found" | "empty" | "error" | "disabled" | "setup";
  message: string | null; checkedAt: number; count: number;
};

export function sourceLanguage(lang: string): string {
  const l = lang.toLowerCase();
  return l === "jp" ? "ja" : ["all", "multi"].includes(l) ? "multi" : l.split("-")[0];
}

export function searchNames(titles: (string | null | undefined)[], query?: string, max = 8): string[] {
  const names = query?.trim() ? [query] : titles;
  const seen = new Set<string>();
  return names.filter((x): x is string => Boolean(x?.trim())).map((x) => x.trim())
    .filter((x) => { const key = x.normalize("NFKC").toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, max);
}

export async function mapSources<T, R>(items: T[], run: (item: T) => Promise<R>, concurrency = 3): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = { status: "fulfilled", value: await run(items[i]) }; }
      catch (reason) { results[i] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

export function bridgeUrl(value: string): string {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Нужен HTTP(S) адрес сервера без пароля и параметров");
  return u.href.replace(/\/+$/, "");
}

export function repositoryUrl(value: string): string {
  if (!value.trim()) return "";
  const u = new URL(value.trim());
  if (u.protocol !== "https:" || u.username || u.password || u.hash) throw new Error("Нужен HTTPS адрес репозитория расширений");
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("Укажите репозиторий, а не профиль GitHub");
    if (parts.includes("raw") || parts.includes("blob")) return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`;
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/repo/index.pb`;
  }
  if (u.hostname === "raw.githubusercontent.com") {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2) return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/repo/index.pb`;
  }
  return u.href;
}
