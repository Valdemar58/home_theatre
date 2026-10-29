import { describe, expect, it } from "vitest";
import { specsFromTorrServerDb, torrentFile } from "./torrent-file";

const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("torrent-file", () => {
  const info = new TextEncoder().encode("d4:name3:abc12:piece lengthi16384ee");

  it(".torrent: announce, announce-list, info как есть", () => {
    const t = dec(torrentFile({ infoBytes: info, trackers: [["http://a/ann"], ["udp://b:1", ""]] }));
    expect(t).toBe("d8:announce12:http://a/ann13:announce-listll12:http://a/annel9:udp://b:1ee4:info" + dec(info) + "e");
  });

  it("без трекеров — только info", () => {
    expect(dec(torrentFile({ infoBytes: info, trackers: [] }))).toBe("d4:info" + dec(info) + "e");
  });

  it("записи из сырой базы TorrServer, мусор и порванные пропускаются", () => {
    const rec = JSON.stringify({ Trackers: [["http://a/ann"]], InfoBytes: btoa(dec(info)), InfoHash: "ABCDEF", DisplayName: "x \"y\" }" });
    const raw = new TextEncoder().encode(`\u0000\u0001garbage${rec}\u0000\u0000{"Trackers":[["x"]],"InfoBytes":"QQ=`);
    const specs = specsFromTorrServerDb(raw);
    expect(specs).toHaveLength(1);
    expect(specs[0].infoHash).toBe("abcdef");
    expect(dec(specs[0].infoBytes)).toBe(dec(info));
    expect(specs[0].trackers).toEqual([["http://a/ann"]]);
  });
});
