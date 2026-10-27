// Картинки персонажа из врезки Fandom: вкладки обликов («Slime» / «Human»), в каждой — вкладки источников
// («Light novel» / «Manga» / «Anime»); берём кадр из аниме, иначе первый. Подпись облика — для сверки с обликами графа.

export type InfoboxImage = { label: string; url: string };

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

/** Полный адрес картинки без масштабирования (revision/latest без scale-to-width). */
const fullUrl = (href: string) => decode(href).replace(/\/scale-to-width-down\/\d+/, "");

/** Серия первого появления в аниме из врезки («Debut … Anime Episode 8: Inherited Will»), нет — null. */
export function parseAnimeDebut(html: string): number | null {
  const box = html.match(/<aside[^>]*portable-infobox[\s\S]*?<\/aside>/)?.[0];
  if (!box) return null;
  const text = box.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = /\bAnime\s+Episode\s+(\d+)/i.exec(text.slice(Math.max(0, text.search(/\bDebut\b/i))));
  return m ? Number(m[1]) : null;
}

/**
 * Страница персонажа среди кандидатов: страница ровно с этим именем (не перенаправление) — она. Иначе одна — она,
 * несколько (тёзки: «Geld» ведёт на «Geld Junior», есть и «Geld Senior») — та, чей дебют в аниме ближе к первому
 * появлению по разбору (±2 серии); не нашлась — никакая: лучше без картинки, чем с чужой.
 */
export function pickWikiPage<P extends { title: string; debut: number | null }>(pages: P[], name: string, firstEp: number | null): P | null {
  const exact = pages.find((p) => p.title.toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact;
  // Перенаправление на другого персонажа: дебют далеко от первого появления
  const fits = pages.filter((p) => p.debut === null || firstEp === null || Math.abs(p.debut - firstEp) <= 2);
  if (fits.length <= 1) return fits[0] ?? null;
  if (firstEp === null) return null;
  const near = fits.filter((p) => p.debut !== null).sort((a, b) => Math.abs(a.debut! - firstEp) - Math.abs(b.debut! - firstEp));
  return near.length === 1 || (near.length > 1 && near[0].debut !== near[1].debut) ? near[0] : null;
}

export function parseInfoboxImages(html: string): InfoboxImage[] {
  const box = html.match(/<aside[^>]*portable-infobox[\s\S]*?<\/aside>/)?.[0];
  if (!box) return [];
  // Вкладки обликов — в панели до первой коллекции картинок
  const firstCollection = box.indexOf("pi-image-collection");
  const panel = box.match(/<section[^>]*pi-panel[^>]*>[\s\S]*?<ul class="wds-tabs">([\s\S]*?)<\/ul>/);
  const formLabels = panel && (firstCollection < 0 || box.indexOf(panel[0]) < firstCollection)
    ? [...panel[1].matchAll(/wds-tabs__tab-label[^>]*>\s*([^<]+?)\s*</g)].map((m) => decode(m[1])) : [];
  const figure = (chunk: string) => {
    const figs = [...chunk.matchAll(/<figure[^>]*pi-image[\s\S]*?<a href="([^"]+)"[^>]*title="([^"]*)"/g)].map((m) => ({ href: m[1], title: decode(m[2]) }));
    return figs.find((f) => /anime/i.test(f.title)) ?? figs[0] ?? null;
  };
  const collections = box.split(/<div class="pi-image-collection[^"]*"[^>]*>/).slice(1);
  if (collections.length) {
    return collections.map((c, i) => ({ c: figure(c), label: formLabels[i] ?? "" }))
      .filter((x) => x.c).map((x) => ({ label: x.label, url: fullUrl(x.c!.href) }));
  }
  const one = box.match(/<figure[^>]*pi-image[\s\S]*?<a href="([^"]+)"/);
  return one ? [{ label: "", url: fullUrl(one[1]) }] : [];
}
