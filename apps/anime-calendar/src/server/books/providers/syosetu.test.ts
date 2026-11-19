import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseEpisode, parseToc } from "./syosetu";

describe("Syosetu: разбор страниц", () => {
  it("оглавление: номер, название, дата (JST)", () => {
    const html = `<div class="p-eplist__sublist"><a href="/n9669bk/1/" class="p-eplist__subtitle">
      プロローグ &amp; 始まり
    </a><div class="p-eplist__update">
      2012/11/22 17:00
    </div></div><div class="p-eplist__sublist"><a href="/n9669bk/2/" class="p-eplist__subtitle">第一話</a><div class="p-eplist__update">2012/11/23 09:30<span title="改稿"></span></div></div>`;
    const toc = parseToc(html, "n9669bk");
    expect(toc.map((e) => [e.num, e.title])).toEqual([[1, "プロローグ & 始まり"], [2, "第一話"]]);
    expect(toc[0].date).toBe(Date.UTC(2012, 10, 22, 8, 0) / 1000);
  });
  it("текст главы: абзацы без отступа, предисловие — через разделитель", () => {
    const html = `<div class="js-novel-text p-novel__text p-novel__text--preface"><p id="Lp1">前書き</p></div>
      <div class="js-novel-text p-novel__text"><p id="L1">　俺は34歳住所不定無職。</p><p id="L2"><br /></p><p id="L3">　人生を後悔している。</p></div>`;
    expect(parseEpisode(html)).toEqual([{ t: "p", text: "前書き" }, { t: "hr" }, { t: "p", text: "俺は34歳住所不定無職。" }, { t: "p", text: "人生を後悔している。" }]);
  });
});
