import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "./env";

function key() {
  if (env.sessionSecret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", env.sessionSecret, "home_theater", "invitation-copy-v1", 32));
}

/** Recoverable only for invitation copying, not password reset/owner setup. */
export function sealInvitation(token: string, id: string): string | null {
  const secret = key();
  if (!secret) return null;
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openInvitation(value: string, id: string): string {
  const secret = key(), [version, iv, tag, ciphertext, extra] = value.split(".");
  if (!secret || version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error("Invitation secret unavailable");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
