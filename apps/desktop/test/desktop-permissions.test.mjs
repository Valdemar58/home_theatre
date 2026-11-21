import { test } from "node:test";
import assert from "node:assert/strict";
import { allowAppFullscreen, allowAppPermission } from "../src/desktop-permissions.mjs";
const trusted = {permission:"fullscreen",ownWindow:true,isMainFrame:true,requestingUrl:"https://cinema.test/anime/1/watch/1",server:"https://cinema.test"};
test("explicit fullscreen is limited to the configured app's main frame",()=>{
  assert.equal(allowAppFullscreen(trusted),true);
  for(const change of [{permission:"automatic-fullscreen"},{permission:"media"},{permission:"clipboard-read"},{ownWindow:false},{isMainFrame:false},{isMainFrame:undefined},{requestingUrl:"https://cinema.test.evil/watch"},{requestingUrl:"https://www.youtube.com/embed/test"},{requestingUrl:"invalid"},{requestingUrl:"data:text/html,probe",server:"data:text/html,other"},{server:""}])
    assert.equal(allowAppFullscreen({...trusted,...change}),false,JSON.stringify(change));
  assert.equal(allowAppFullscreen({...trusted,server:"http://127.0.0.1:5057",requestingUrl:"http://127.0.0.1:5057/watch"}),true);
});
test("clipboard writing is limited to the app main frame and never grants reading",()=>{
  const write={...trusted,permission:"clipboard-sanitized-write"};
  assert.equal(allowAppPermission(write),true);
  assert.equal(allowAppPermission(trusted),true);
  for(const change of [{permission:"clipboard-read"},{permission:"deprecated-sync-clipboard-read"},{permission:"clipboard-write"},{permission:"media"},{ownWindow:false},{isMainFrame:false},{isMainFrame:undefined},{requestingUrl:"https://cinema.test.evil/"},{requestingUrl:"https://www.youtube.com/embed/test"},{server:""}])
    assert.equal(allowAppPermission({...write,...change}),false,JSON.stringify(change));
});
