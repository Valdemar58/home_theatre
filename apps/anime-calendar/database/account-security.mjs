import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
const derive = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
export const tokenHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password) > 256
  )
    throw new Error("Пароль должен содержать от 12 до 256 байт");
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt}$${key.toString("hex")}`;
}
const dummy =
  "scrypt$32768$8$1$00000000000000000000000000000000$" + "00".repeat(64);
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 256)
    return false;
  const value = typeof encoded === "string" ? encoded : dummy;
  const parts = value.split("$");
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join("$") !== "scrypt$32768$8$1" ||
    !/^[a-f0-9]{32}$/.test(parts[4]) ||
    !/^[a-f0-9]{128}$/.test(parts[5])
  )
    return false;
  const key = await derive(password, parts[4]);
  return timingSafeEqual(key, Buffer.from(parts[5], "hex")) && !!encoded;
}
