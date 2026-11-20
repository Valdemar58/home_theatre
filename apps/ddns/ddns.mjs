// Обновление адреса DuckDNS (TASKS 9.4б): <домен>.duckdns.org → домашний внешний IP.
// Домашний IP узнаём по STUN (UDP на высокий порт: идёт мимо VPN — веб-запросы контейнеров уходят в VPN, и DuckDNS
// увидел бы адрес VPN-сервера), DuckDNS сообщаем его явно (&ip=). Раз в 5 минут; в DuckDNS — когда адрес сменился
// и раз в сутки на всякий случай. Без зависимостей: node:22-alpine.
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

const DOMAIN = process.env.DUCKDNS_DOMAIN ?? "";
const TOKEN = process.env.DUCKDNS_TOKEN ?? "";
const ENABLED = process.env.DDNS_ENABLED !== "0";
const EVERY = 5 * 60_000;
const FORCE = 24 * 3600_000;
// Российский STUN первым — иностранные могут резать
const STUN = [["stun.sipnet.ru", 3478], ["stun.l.google.com", 19302], ["stun.cloudflare.com", 3478]];

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Внешний адрес по STUN (Binding Request, ответ XOR-MAPPED-ADDRESS, RFC 5389). */
function stun(host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const id = randomBytes(12);
    const req = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), id]);
    const timer = setTimeout(() => { sock.close(); reject(new Error("нет ответа")); }, 4000);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      for (let i = 20; i + 4 <= msg.length;) {
        const type = msg.readUInt16BE(i);
        const len = msg.readUInt16BE(i + 2);
        // 0x0020 — XOR-MAPPED-ADDRESS, 0x0001 — MAPPED-ADDRESS (старые серверы); семейство 1 — IPv4
        if ((type === 0x0020 || type === 0x0001) && msg[i + 5] === 1) {
          const b = msg.subarray(i + 8, i + 12);
          const ip = type === 0x0020 ? [...b].map((x, k) => x ^ [0x21, 0x12, 0xa4, 0x42][k]) : [...b];
          return resolve(ip.join("."));
        }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      reject(new Error("в ответе нет адреса"));
    });
    sock.on("error", (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(req, port, host);
  });
}

async function homeIp() {
  // Два сервера должны совпасть — иначе ответ одного из них мог пройти через VPN
  const got = [];
  for (const [h, p] of STUN) {
    try { got.push(await stun(h, p)); } catch (e) { log(`STUN ${h}: ${e.message}`); }
    if (got.length >= 2) break;
  }
  if (!got.length) throw new Error("ни один STUN не ответил");
  if (got.length > 1 && got[0] !== got[1]) throw new Error(`STUN расходятся: ${got.join(" / ")}`);
  return got[0];
}

let last = null;
let lastAt = 0;
async function tick() {
  const ip = await homeIp();
  if (ip === last && Date.now() - lastAt < FORCE) return;
  const res = await fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(DOMAIN)}&token=${encodeURIComponent(TOKEN)}&ip=${ip}`, { signal: AbortSignal.timeout(20_000) });
  const text = (await res.text()).trim();
  if (text !== "OK") throw new Error(`DuckDNS ответил «${text.slice(0, 40)}»`);
  log(`${DOMAIN}.duckdns.org → ${ip}${last && last !== ip ? ` (был ${last})` : ""}`);
  last = ip;
  lastAt = Date.now();
}

if (!ENABLED) {
  log("Обновление DuckDNS отключено (DDNS_ENABLED=0)");
  setInterval(() => {}, 1 << 30);
} else if (!DOMAIN || !TOKEN) {
  log("Нет DUCKDNS_DOMAIN или DUCKDNS_TOKEN в .env — нечего обновлять");
  setInterval(() => {}, 1 << 30);
} else {
  const run = () => tick().catch((e) => log(`ошибка: ${e.message}`));
  await run();
  setInterval(run, EVERY);
}
