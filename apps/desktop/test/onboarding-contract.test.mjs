import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {onboardingEndpoints} from "../src/onboarding-endpoints.mjs";

// Validate against real Next routes, not the permissive onboarding mock bridge.
for(const [action,{path,method}] of Object.entries(onboardingEndpoints)){
  test(`${action}: server implements ${method} ${path}`,async()=>{
    const route=await readFile(new URL(`../../anime-calendar/src/app${path}/route.ts`,import.meta.url),"utf8");
    assert.match(route,new RegExp(`export\\s+(?:(?:async\\s+)?function\\s+${method}\\b|(?:const|let)\\s+${method}\\s*=)`));
  });
}
