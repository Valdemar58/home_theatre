import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Windows scanners can briefly hold the destination open. Never delete the
// last good state to work around a failed replacement.
export async function atomicWrite(file, data, io = { writeFile, rename, unlink, delay }) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, file); return; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await io.delay(25 * 2 ** attempt);
      }
    }
  } finally {
    await io.unlink(temporary).catch(() => {});
  }
}
