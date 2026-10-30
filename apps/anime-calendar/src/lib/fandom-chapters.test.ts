import { describe, expect, it } from "vitest";
import { fandomChapter } from "./fandom-chapters";

const page = `{{Infobox chapter
|title = Chapter 10
|adaptation = [[Empowerment|Light novel volume 1: Empowerment]]
}}
Intro.

== Synopsis ==
Information to be added.

== Summary ==
[[File:Chapter 10 - Rimuru.jpg|thumb|left|220px|Rimuru binds Ifrit]]
[[Ifrit]] comes out of [[Shizu]] and takes over. [[Rimuru Tempest|Rimuru]] asks him what his goal is, however Ifrit doesn't reply.<ref>x</ref>

Rimuru tells [[Ranga]] to focus on dodging while preparing a ''water'' attack.

== Characters ==
* Rimuru`;

describe("глава манги на Fandom", () => {
  it("номер из инфобокса, пересказ из Summary без разметки", () => {
    const c = fandomChapter(page)!;
    expect(c.num).toBe(10);
    expect(c.text).toBe("Ifrit comes out of Shizu and takes over. Rimuru asks him what his goal is, however Ifrit doesn't reply.\n\nRimuru tells Ranga to focus on dodging while preparing a water attack.");
  });
  it("без пересказа — null", () => {
    expect(fandomChapter("{{Infobox chapter\n|title = Chapter 3\n}}\n== Synopsis ==\nInformation to be added.")).toBeNull();
  });
});
