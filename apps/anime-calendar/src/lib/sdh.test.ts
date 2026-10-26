import { describe, expect, it } from "vitest";
import { cueLines, episodeOfFile, isSoundLabel, matchFiles, parseAss, parseSrt, sdhRank } from "./sdh";

// Короткие выдуманные реплики в формате ТВ/Netflix/Amazon SDH (настоящие субтитры в репозиторий не кладём)
const SRT = `﻿1
00:00:08,508 --> 00:00:10,301
（人々の叫び声）

2
00:00:19,394 --> 00:00:21,187
（少女）ハア ハア…

3
00:00:28,403 --> 00:00:30,822
お母さん！　防空壕(ぼうくうごう)は？

4
00:01:11,029 --> 00:01:13,865
（三上(みかみ) 悟(さとる)）
なんということもない普通の人生

5
00:01:20,000 --> 00:01:22,000
♪～

6
00:01:30,000 --> 00:01:32,000
（沢渡･田村）先輩！
〈もしもし？〉
`;

describe("parseSrt", () => {
  const p = parseSrt(SRT);

  it("все блоки разобраны, тайминг в мс", () => {
    expect(p.blocks).toBe(6);
    expect(p.cues).toHaveLength(6);
    expect(p.cues[0]).toMatchObject({ start: 8508, end: 10301 });
  });

  it("звук, говорящий, фуригана, музыка, голос из-за кадра", () => {
    expect(p.cues[0].lines).toEqual([{ kind: "sound", speakers: [], text: "人々の叫び声" }]);
    expect(p.cues[1].lines).toEqual([{ kind: "speech", speakers: ["少女"], text: "ハア ハア…" }]);
    expect(p.cues[2].lines[0]).toMatchObject({ speakers: [], text: "お母さん！　防空壕は？" });
    expect(p.cues[3].lines).toEqual([{ kind: "speech", speakers: ["三上悟"], text: "なんということもない普通の人生" }]);
    expect(p.cues[4].lines[0].kind).toBe("music");
    expect(p.cues[5].lines).toEqual([
      { kind: "speech", speakers: ["沢渡", "田村"], text: "先輩！" },
      { kind: "offscreen", speakers: ["沢渡", "田村"], text: "もしもし？" },
    ]);
    expect(p.readings).toMatchObject({ 防空壕: "ぼうくうごう", 三上: "みかみ", 悟: "さとる" });
  });
});

describe("isSoundLabel", () => {
  it("звуки по суффиксу", () => {
    for (const s of ["爆発音", "人々の悲鳴", "女の悲鳴", "水に落ちた音", "正解音", "拍手", "ドアの開く音", "歓声"]) expect(isSoundLabel(s)).toBe(true);
  });
  it("имена и роли — не звуки; имя из справочника важнее суффикса", () => {
    for (const s of ["スライム", "大賢者", "通行人", "ナレーター", "３人"]) expect(isSoundLabel(s)).toBe(false);
    expect(isSoundLabel("鈴音", new Set(["鈴音"]))).toBe(false);
  });
});

describe("cueLines", () => {
  it("звук и реплика в одной строке", () => {
    expect(cueLines(["（物音）誰だ？"], {})).toEqual([
      { kind: "sound", speakers: [], text: "物音" },
      { kind: "speech", speakers: [], text: "誰だ？" },
    ]);
  });
});

describe("parseAss", () => {
  const ASS = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\c&H00FFFF&}（リムル）よし\\Nいくぞ
Dialogue: 0,0:00:08.00,0:00:09.00,Sign,,0,0,0,,{\\pos(320,50)}看板
Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,{\\an8}そうだな、行こう`;
  const p = parseAss(ASS);

  it("реплики, цвет и позиция; надписи — не реплики", () => {
    expect(p.blocks).toBe(3);
    expect(p.cues).toHaveLength(2);
    expect(p.cues[0]).toMatchObject({ start: 5000, end: 7500, color: "00FFFF" });
    expect(p.cues[0].lines).toEqual([
      { kind: "speech", speakers: ["リムル"], text: "よし" },
      { kind: "speech", speakers: ["リムル"], text: "いくぞ" },
    ]);
    expect(p.cues[1]).toMatchObject({ pos: "an8" });
    expect(p.cues[1].lines[0].text).toBe("そうだな、行こう");
  });
});

describe("episodeOfFile / sdhRank", () => {
  it("номер серии из разных схем имён", () => {
    expect(episodeOfFile("転生したらスライムだった件.S01E05.第5話.英雄王.WEBRip.Amazon.ja-jp[sdh].srt")).toBe(5);
    expect(episodeOfFile("[Judas] Tensei Shitara Slime Datta Ken - S01E12.srt")).toBe(12);
    expect(episodeOfFile("[AnimeKayo] Tensei shitara Slime Datta Ken [720p][Eng Sub][x265] Ep 03 [Neel].ja.srt")).toBe(3);
    expect(episodeOfFile("Show - 07.ass")).toBe(7);
    expect(episodeOfFile("readme.txt")).toBeNull();
  });

  it("Netflix и Amazon SDH выше ТВ; половинки, архивы, двуязычные — нет", () => {
    const amazon = sdhRank("x.S01E01.WEBRip.Amazon.ja-jp[sdh].srt");
    const netflix = sdhRank("x.S01E01.WEBRip.Netflix.ja[cc].srt");
    const tv = sdhRank("[Judas] x - S01E01.srt");
    expect(netflix).toBeGreaterThan(amazon);
    expect(amazon).toBeGreaterThan(tv);
    expect(tv).toBeGreaterThan(0);
    expect(sdhRank("x.S01E24.5.WEBRip.ja[cc].srt")).toBe(-1);
    expect(sdhRank("x.zip")).toBe(-1);
    expect(sdhRank("[AnimeKayo] x Ep 03 [Neel].ja-en.ass")).toBe(0);
  });
});

describe("matchFiles", () => {
  const f = (name: string) => ({ name });

  it("название серии важнее номера в имени («S01E01.第2話»)", () => {
    const m = matchFiles([f("Tomodachi Game.S01E01.第2話.あれ？.友一君は友達を疑ってるの？.WEBRip.Amazon.ja-jp[sdh].srt")],
      new Map([[1, "友情は金で買える"], [2, "あれ？友一君は友達を疑ってるの？"]]), 12);
    expect([...m.keys()]).toEqual([2]);
  });

  it("сквозная нумерация «第49話» у третьего сезона — со сдвигом", () => {
    const m = matchFiles([f("x.S03E01.第49話.a.WEBRip.Netflix.ja[cc].srt"), f("x.S03E02.第50話.b.WEBRip.Netflix.ja[cc].srt"), f("x.S03E01.第48.5話.c.WEBRip.Amazon.ja-jp[sdh].srt")],
      new Map(), 24);
    expect([...m.keys()]).toEqual([1, 2]);
  });

  it("лучший файл серии — Netflix, потом Amazon; вне сезона — не берём", () => {
    const m = matchFiles([f("[Judas] x - S01E03.srt"), f("x.S01E03.第3話.t.WEBRip.Amazon.ja-jp[sdh].srt"), f("x.S01E03.t.WEBRip.Netflix.ja[cc].srt"), f("x - S01E30.srt")], new Map(), 24);
    expect(m.get(3)?.name).toContain("Netflix");
    expect(m.has(30)).toBe(false);
  });
});
