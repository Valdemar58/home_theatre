// Картинки персонажа из врезки Fandom: вкладки обликов («Slime» / «Human»), в каждой — вкладки источников
// («Light novel» / «Manga» / «Anime»); берём кадр из аниме, иначе первый. Подпись облика — для сверки с обликами графа.

export type InfoboxImage = { label: string; url: string };

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

/** Полный адрес картинки без масштабирования (revision/latest без scale-to-width). */
const fullUrl = (href: string) => decode(href).replace(/\/scale-to-width-down\/\d+/, "");

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
