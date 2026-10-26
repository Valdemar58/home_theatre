import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTopic } from "./topic-parse";

const page = (title: string, body: string) =>
  `<html><h1 class="maintitle"><a id="topic-title" href="#">${title}</a></h1>
   <div class="post_body" id="p-1">${body}</div>
   <div class="post_body" id="p-2">Аудио RUS: от Комментатора | Lol</div></html>`;

describe("parseTopic", () => {
  it("название с разметкой кириллицы и <wbr>", () => {
    const info = parseTopic(page(
      '<span class="cyrillic-char">О</span> <span class="cyrillic-char">моём</span> перерождении<wbr> в слизь (ТВ-3) / Tensei Shitara Slime Datta Ken 3 [TV+Special] [24+2 из 24+2] [RUS(ext)] [2024, WEB-DL] [1080p]', ""));
    expect(info.title).toBe("О моём перерождении в слизь (ТВ-3) / Tensei Shitara Slime Datta Ken 3 [TV+Special] [24+2 из 24+2] [RUS(ext)] [2024, WEB-DL] [1080p]");
  });

  it("студии в скобках у русских дорожек, японская дорожка не учитывается", () => {
    const info = parseTopic(page("x", `
      <span>Аудио #1: AAC, 2 ch, 48.0 kHz, 192 kb/s, Язык Русский - MVO (AniStar)</span><br>
      <span>Аудио #2: AAC, 2 ch, 48.0 kHz, 192 kb/s, Язык Русский - MVO (AniLibria.TV)</span><br>
      <span>Аудио #3: AAC, 2 ch, 48.0 kHz, Язык Японский (Crunchyroll)</span>`));
    expect(info.voices).toEqual(["AniStar", "AniLibria"]);
    expect(info.kinds).toEqual(["MVO"]);
  });

  it("«Дубляж от DEEP», служебное в скобках отбрасывается", () => {
    const info = parseTopic(page("x",
      "Аудио RUS : AAC LC, 2.0 канала, 48.0 кГц, ~192 кбит/с | Русский язык (внешними файлами) | Дубляж от DEEP (только для TV)<br>" +
      "Аудио JPN : AAC LC | Японский язык (в составе контейнера) | от Crunchyroll"));
    expect(info.voices).toEqual(["DEEP"]);
    expect(info.kinds).toEqual(["Dub"]);
  });

  it("строка «Озвучка:» со списком и комментарии не читаются", () => {
    const info = parseTopic(page("x", "Озвучка: Многоголосая закадровая (Dream Cast, Студия Band)<br>Озвучка: AniDub и SHIZA Project"));
    expect(info.voices).toEqual(["Dream Cast", "Band", "AniDUB", "SHIZA"]);
    expect(info.voices).not.toContain("Lol");
  });
});

describe("parseTopic: настоящие страницы RuTracker", () => {
  const fixture = (id: string) => fs.readFileSync(path.join(__dirname, "fixtures", `topic-${id}.html`), "utf-8");

  it("две многоголосые озвучки в строках «Аудио #N»", () => {
    const info = parseTopic(fixture("6554906"));
    expect(info.title).toMatch(/^О моём перерождении в слизь \(ТВ-1\) \/ Tensei Shitara Slime Datta Ken/);
    expect(info.voices).toEqual(["AniStar", "AniLibria"]);
    expect(info.kinds).toEqual(["MVO"]);
  });

  it("дубляж «от DEEP» во внешних файлах", () => {
    const info = parseTopic(fixture("6510132"));
    expect(info.voices).toContain("DEEP");
    expect(info.kinds).toContain("Dub");
  });
});

describe("очистка студий", () => {
  it("«по заказу», русские написания и форматы файлов", () => {
    const info = parseTopic(page("x",
      "Аудио #1: Русский язык | MVO (Анилибрии по заказу DEEP)<br>" +
      "Аудио #2: Русский язык (mka, AC-3) | Дубляж от Шизы<br>" +
      "Аудио #3: Русский язык | MVO (по заказу DEEP) (Special)"));
    expect(info.voices).toEqual(["AniLibria", "SHIZA"]);
  });
});

