import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installationKey} from "../src/device-identity.mjs";
test("installation identity survives restarts and does not silently replace corrupt keys",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"desktop-key-"));
 try{const file=join(dir,"installation.key"),key=await installationKey(file);
 assert.match(key,/^[a-f0-9]{64}$/);assert.equal(await installationKey(file),key);
 await writeFile(file,"broken");await assert.rejects(()=>installationKey(file),/Повреждён/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
