import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Profiles,normalizeServerAddress} from '../src/profiles.mjs';
test('profile migration retains legacy secret, session, paths and arbitrary settings exactly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'desktop-profiles-'));try{
 const legacy={server:'https://cinema.example',approved:true,secret:'encrypted-preserved',deviceId:'stable-device',downloadFolder:'D:/Anime',custom:{keep:true}};
 const bytes=JSON.stringify(legacy);await writeFile(join(dir,'host.json'),bytes);
 const store=new Profiles(dir);await store.load();const id=store.active.id;
 assert.deepEqual(store.active.settings,legacy);assert.equal(store.partition(),undefined);assert.equal(store.directoryFor(),dir);assert.equal(store.active.wizard.step,'done');
 assert.equal(await readFile(join(dir,'host.json.before-profiles'),'utf8'),bytes);
 const other=store.ensure('https://other.example','Другой');assert.notEqual(store.partition(other),store.partition());assert.notEqual(store.directoryFor(other),dir);assert.equal(other.settings.secret,undefined);
 assert.equal(store.ensure(other.origin,'duplicate').id,other.id);await store.save();const again=new Profiles(dir);await again.load();assert.equal(again.active.id,id);assert.deepEqual(again.active.settings,legacy);assert(!JSON.stringify(again.list()).includes('encrypted-preserved'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('user links normalize without changing strict persisted-origin validation',()=>{
 for(const input of ['cinema.example/watch?q=a#b',' https://CINEMA.example/watch?q=1 ','//cinema.example/a','http://cinema.example/a','https://user:secret@cinema.example/a'])assert.equal(normalizeServerAddress(input),'https://cinema.example');
 assert.equal(normalizeServerAddress('https://cinema.example:8443/a'),'https://cinema.example:8443');
 assert.equal(normalizeServerAddress('http://localhost:5056/path',{development:true}),'http://localhost:5056');
 for(const input of ['', 'неверный адрес','file:///tmp/a','https://bad host/a'])assert.throws(()=>normalizeServerAddress(input));
});
