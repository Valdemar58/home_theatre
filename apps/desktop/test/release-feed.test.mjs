import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {metadataFeed,prepareRelease} from "../../../scripts/ci/desktop-release.mjs";
const require=createRequire(import.meta.url),yaml=createRequire(require.resolve("electron-updater"))("js-yaml");
const version="1.0.0-rc.3",repository="owner/repo",commit="c".repeat(40);
const metadata=(name,bytes,releaseVersion=version)=>({version:releaseVersion,path:name,sha512:createHash("sha512").update(bytes).digest("base64"),files:[{url:name,size:bytes.length,sha512:createHash("sha512").update(bytes).digest("base64")}]});
async function fixture(t,releaseVersion=version){const prefix=join(tmpdir(),"home-theater-feed-"),dir=await mkdtemp(prefix);t.after(async()=>{assert(dir.startsWith(prefix));await rm(dir,{recursive:true,force:true});});for(const[platform,ext]of[["win","exe"],["linux","AppImage"]]){const name=`app.${ext}`,bytes=Buffer.from(platform);await writeFile(join(dir,name),bytes);await writeFile(join(dir,platform+".yml"),yaml.dump(metadata(name,bytes,releaseVersion)));await writeFile(join(dir,`build-${platform}.json`),JSON.stringify({version:releaseVersion,commit}));}return dir;}
test("feed references immutable versioned assets on both platforms",async t=>{const dir=await fixture(t),out=join(dir,"feed");await prepareRelease(dir,{version,repository,commit,output:out});for(const name of["preview.yml","preview-linux.yml"]){const m=yaml.load(await readFile(join(out,name),"utf8"));assert.equal(m.version,version);assert.match(m.files[0].url,/^https:\/\/github.com\/owner\/repo\/releases\/download\/v1.0.0-rc.3\//);assert.equal(m.path,m.files[0].url);}assert.match(await readFile(join(dir,"SHA256SUMS.txt"),"utf8"),/app.exe/);});
test("a corrupt installer cannot become the current feed",async t=>{const dir=await fixture(t);await writeFile(join(dir,"app.exe"),"tampered");await assert.rejects(prepareRelease(dir,{version,repository,commit,output:join(dir,"feed")}),/integrity/);});
test("mixed commits cannot be published as one release",async t=>{const dir=await fixture(t);await writeFile(join(dir,"build-linux.json"),JSON.stringify({version,commit:"other"}));await assert.rejects(prepareRelease(dir,{version,repository,commit,output:join(dir,"feed")}),/Mixed source/);});
test("feed metadata cannot escape the verified artifact directory",()=>{for(const name of["../app.exe","https://other.example/app.exe","%2e%2e.exe","a\\app.exe"]){assert.throws(()=>metadataFeed(metadata(name,Buffer.from("x")),{version,repository,tag:`v${version}`}),/Invalid installer/);}});
test("stable requires owner approval and can promote preview users without a downgrade",async t=>{const version="1.0.0",dir=await fixture(t,version),out=join(dir,"feed");await assert.rejects(prepareRelease(dir,{version,repository,commit,output:out}),/owner approval/);const result=await prepareRelease(dir,{version,repository,commit,output:out,approveStable:true});assert.equal(result.channel,"stable");for(const file of["latest.yml","latest-linux.yml","preview.yml","preview-linux.yml"])assert.equal(yaml.load(await readFile(join(out,file),"utf8")).version,version);});
