import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function installationKey(path) {
  await mkdir(dirname(path), {recursive:true});
  try { await writeFile(path, randomBytes(32).toString("hex"), {flag:"wx",mode:0o600}); }
  catch(e) { if(e.code!=="EEXIST")throw e; }
  const key=(await readFile(path,"utf8")).trim();
  if(!/^[a-f0-9]{64}$/.test(key))throw new Error("Повреждён идентификатор устройства. Не создаём повторную привязку.");
  return key;
}
