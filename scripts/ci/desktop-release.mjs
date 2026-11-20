import {createRequire} from "node:module";
import {readFile,readdir,writeFile,mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {basename,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const require=createRequire(new URL("../../apps/desktop/package.json",import.meta.url));
const semver=require("semver"),yaml=createRequire(require.resolve("electron-updater"))("js-yaml");

export function metadataFeed(metadata,{version,repository,tag}){
  if(!semver.valid(version)||metadata.version!==version)throw Error("Release version does not match metadata");
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||tag!==`v${version}`)throw Error("Invalid release destination");
  if(!Array.isArray(metadata.files)||!metadata.files.length)throw Error("Missing installer metadata");
  const result=structuredClone(metadata);
  for(const f of result.files){
    if(typeof f.url!=="string"||f.url!==basename(f.url)||/[\\/%]/.test(f.url)||!f.sha512||!(f.size>0))throw Error("Invalid installer reference");
    f.url=`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(f.url)}`;
  }
  if(metadata.path){const file=result.files.find((f,i)=>metadata.files[i].url===metadata.path);if(!file)throw Error("Unknown legacy installer reference");result.path=file.url;}
  return result;
}

export async function prepareRelease(directory,{version,repository,commit,output,approveStable=false}){
  if(!semver.valid(version)||version.includes("+"))throw Error("Use an incremented semantic release version without build metadata");
  const channel=semver.prerelease(version)?"preview":"stable",feedName=channel==="preview"?"preview":"latest";
  if(channel==="stable"&&!approveStable)throw Error("Stable publication requires separate owner approval");
  const names=await readdir(directory),platforms=new Map();
  for(const name of names.filter(n=>/\.yml$/.test(n))){
    const meta=yaml.load(await readFile(join(directory,name),"utf8"),{schema:yaml.JSON_SCHEMA});
    if(!meta?.files)continue;
    const normalized=metadataFeed(meta,{version,repository,tag:`v${version}`});
    const platform=meta.files.some(f=>f.url.endsWith(".exe"))?"win":meta.files.some(f=>f.url.endsWith(".AppImage"))?"linux":null;
    if(!platform)throw Error("Unknown desktop platform");
    for(const f of meta.files){const bytes=await readFile(join(directory,f.url));if(bytes.length!==f.size||createHash("sha512").update(bytes).digest("base64")!==f.sha512)throw Error(`Installer integrity mismatch: ${f.url}`);}
    if(platforms.has(platform)&&JSON.stringify(platforms.get(platform).files)!==JSON.stringify(normalized.files))throw Error("Conflicting channel metadata");
    platforms.set(platform,normalized);
  }
  if(!platforms.has("win")||!platforms.has("linux"))throw Error("Both desktop platforms are required before publication");
  for(const platform of ["win","linux"]){
    const build=JSON.parse(await readFile(join(directory,`build-${platform}.json`),"utf8"));
    if(build.version!==version||build.commit!==commit)throw Error("Mixed source revisions in desktop release");
  }
  await mkdir(output,{recursive:true});
  for(const [platform,meta]of platforms){
    await writeFile(join(output,platform==="win"?`${feedName}.yml`:`${feedName}-linux.yml`),yaml.dump(meta,{lineWidth:-1}));
    if(channel==="stable")await writeFile(join(output,platform==="win"?"preview.yml":"preview-linux.yml"),yaml.dump(meta,{lineWidth:-1}));
  }
  const published=names.filter(n=>/\.(exe|AppImage|blockmap|yml)$/.test(n)&&!n.startsWith("builder-"));
  const sums=[];for(const name of published)sums.push(`${createHash("sha256").update(await readFile(join(directory,name))).digest("hex")}  ${name}`);
  await writeFile(join(directory,"SHA256SUMS.txt"),sums.join("\n")+"\n");
  await writeFile(join(directory,"release.json"),JSON.stringify({version,commit,windows:"candidate",linux:"preview",artifacts:published},null,2));
  return {version,commit,channel,feedFiles:[`${feedName}.yml`,`${feedName}-linux.yml`],artifacts:published};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  if(command==="prepare"){const [directory,version,repository,commit,output]=args;console.log(JSON.stringify(await prepareRelease(directory,{version,repository,commit,output,approveStable:args.includes("--approve-stable")})));}
  else if(command==="newer"){const [next,previous]=args;if(!semver.valid(next)||!semver.valid(previous))throw Error("Invalid feed version");process.exitCode=semver.gte(next,previous)?0:3;}
  else throw Error("Expected prepare or newer command");
}
