import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// Resolve the actual ESM dependency graph under either pnpm or a flat installation.
const web = dirname(fileURLToPath(import.meta.resolve("webtorrent")));
const discovery = realpathSync(resolve(web, "../torrent-discovery"));
const tracker = resolve(
  realpathSync(resolve(discovery, "../bittorrent-tracker")),
  "index.js",
);
test("UDP tracker parser decodes protocol IPv4 and sender fallback without the vulnerable ip package", async () => {
  const { default: parse } = await import(
    new URL("./lib/server/parse-udp.js", pathToFileURL(tracker))
  );
  const msg = Buffer.alloc(98);
  Buffer.from("0000041727101980", "hex").copy(msg);
  msg.writeUInt32BE(1, 8);
  msg.writeUInt32BE(2, 80);
  msg.set([192, 168, 1, 9], 84);
  msg.writeUInt16BE(6881, 96);
  assert.equal(
    parse(msg, { address: "127.0.0.1", port: 6881 }).ip,
    "192.168.1.9",
  );
  msg.writeUInt32BE(0, 84);
  assert.equal(
    parse(msg, { address: "127.0.0.1", port: 6881 }).ip,
    "127.0.0.1",
  );
  assert.throws(() => createRequire(tracker).resolve("ip"), {
    code: "MODULE_NOT_FOUND",
  });
});
