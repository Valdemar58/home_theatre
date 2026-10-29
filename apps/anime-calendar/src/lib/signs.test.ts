import { describe, expect, it } from "vitest";
import { buildAss, isSign, plainText, signEvents, signTexts, splitAss, withText } from "./signs";

const ASS = `﻿[Script Info]
Title: Test
PlayResX: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,60
Style: Sign,Arial,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,Rimuru,0,0,0,,Hello, world!
Dialogue: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,{\\pos(300,200)\\fs40}Tempest\\NVillage
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\an8\\pos(960,80)}Chapter One
Dialogue: 1,0:00:05.00,0:00:06.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Dialogue: 0,0:00:07.00,0:00:08.00,Overlap,,0,0,0,,{\\pos(10,10)}Overlapping talk
Dialogue: 0,0:00:09.00,0:00:10.00,OP Romaji,,0,0,0,,{\\k20}sora
`;

describe("надписи из ASS", () => {
  const parts = splitAss(ASS);
  it("шапка и события разобраны, запятые в тексте не ломают поля", () => {
    expect(parts.header[0]).toBe("[Script Info]");
    expect(parts.events).toHaveLength(6);
    expect(parts.events[0]).toMatchObject({ style: "Default", name: "Rimuru", text: "Hello, world!" });
  });
  it("надпись — по стилю или по месту в кадре у нерепличного стиля", () => {
    expect(signEvents(parts).map((e) => e.style)).toEqual(["Sign", "Sign", "OP Romaji"]);
    expect(isSign({ style: "Default", text: "{\\pos(1,1)}x" })).toBe(false);
    expect(isSign({ style: "Screen", text: "x" })).toBe(true);
    expect(isSign({ style: "Caption2", text: "{\\pos(1,1)}x" })).toBe(true);
    expect(isSign({ style: "Whatever", text: "{\\move(1,1,2,2)}x" })).toBe(true);
  });
  it("тексты для перевода — без тегов и рисунков", () => {
    expect(plainText("{\\pos(1,1)}Tempest\\NVillage")).toBe("Tempest\nVillage");
    expect(signTexts(signEvents(parts))).toEqual(["Tempest\nVillage", "sora"]);
  });
  it("перевод: теги в начале строки остаются, дорожка собирается со стилями", () => {
    const sign = signEvents(parts)[0];
    const ru = withText(sign, "Темпест\nДеревня");
    expect(ru.raw).toBe("Dialogue: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,{\\pos(300,200)\\fs40}Темпест\\NДеревня");
    const out = buildAss(parts, [ru]);
    expect(out).toContain("Style: Sign,Arial,40");
    expect(out).toContain("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00");
    expect(out).not.toContain("Hello, world!");
  });
});
