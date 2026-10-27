import { describe, expect, it } from "vitest";
import { parseInfoboxImages } from "./fandom-images";

const fig = (title: string, name: string) =>
  `<figure class="pi-item pi-image"><a href="https://static.wikia.nocookie.net/w/images/${name}/revision/latest?cb=1" class="image image-thumbnail" title="${title}"><img src="x"/></a></figure>`;
const tabs = (labels: string[]) => `<ul class="wds-tabs">${labels.map((l) => `<li class="wds-tabs__tab"><div class="wds-tabs__tab-label"> ${l} </div></li>`).join("")}</ul>`;

describe("parseInfoboxImages", () => {
  it("вкладки обликов, кадр из аниме", () => {
    const html = `<aside class="portable-infobox"><section class="pi-item pi-panel wds-tabber"><div class="wds-tabs__wrapper">${tabs(["Slime", "Human"])}</div>
      <div class="wds-tab__content"><div class="pi-image-collection wds-tabber" data-source="image">${fig("Light novel", "a.png")}${fig("Anime", "b.png")}</div></div>
      <div class="wds-tab__content"><div class="pi-image-collection wds-tabber" data-source="image">${fig("Manga", "c.png")}</div></div></section></aside>`;
    expect(parseInfoboxImages(html)).toEqual([
      { label: "Slime", url: "https://static.wikia.nocookie.net/w/images/b.png/revision/latest?cb=1" },
      { label: "Human", url: "https://static.wikia.nocookie.net/w/images/c.png/revision/latest?cb=1" },
    ]);
  });
  it("одна картинка без вкладок", () => {
    expect(parseInfoboxImages(`<aside class="portable-infobox">${fig("Shizu", "s.png")}</aside>`)).toEqual([{ label: "", url: "https://static.wikia.nocookie.net/w/images/s.png/revision/latest?cb=1" }]);
  });
});
