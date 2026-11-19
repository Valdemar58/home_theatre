// Manual UI test only. Local proxy authenticates a synthetic account on an isolated
// Docker server. Never point this helper at production or expose it beyond loopback.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
const require = createRequire(
  new URL("../../anime-calendar/package.json", import.meta.url),
);
const { sealData } = require("iron-session");
const cookie = await sealData(
  { userId: process.env.M6_VIEWER === "2" ? 2 : 1 },
  { password: "m5-local-fixture-secret-only-000000000000", ttl: 3600 },
);
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = {
      ...req.headers,
      cookie: `anime_calendar_session=${cookie}`,
    };
    delete headers["content-length"];
    delete headers.connection;
    headers.host = "127.0.0.1:5057";
    if (["http://127.0.0.1:5058", "http://127.0.0.1:5059"].includes(headers.origin))
      headers.origin = "http://127.0.0.1:5057";
    const r = await fetch(`http://127.0.0.1:5057${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : Buffer.concat(chunks),
      redirect: "manual",
    });
    res.writeHead(
      r.status,
      Object.fromEntries(
        [...r.headers].filter(
          ([k]) =>
            ![
              "content-encoding",
              "content-length",
              "transfer-encoding",
            ].includes(k),
        ),
      ),
    );
    if (r.body) { const stream = Readable.fromWeb(r.body); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); } else res.end();
  } catch (e) {
    if (!res.headersSent) { res.writeHead(502); res.end(e.message); } else res.destroy();
  }
}).listen(process.env.M6_VIEWER === "2" ? 5059 : 5058, "127.0.0.1", () =>
  console.log("Synthetic UI fixture ready on loopback"),
);
