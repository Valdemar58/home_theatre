import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/** Full bytes, not filename/size/sample hashes. Never publish the local path.
 * This identifies a source file, not a prepared rendition's timeline.
 */
export async function identifyFile(
  path,
  { signal, onProgress = () => {} } = {},
) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n)
      throw new Error("Нужен непустой обычный файл");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      onProgress(bytes / Number(before.size));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== before.size
    ) {
      throw new Error(
        "Файл изменился во время проверки; повторите подключение",
      );
    }
    return { version: `sha256:${hash.digest("hex")}`, bytes };
  } finally {
    await handle.close();
  }
}
