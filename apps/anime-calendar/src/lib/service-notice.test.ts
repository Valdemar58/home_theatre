import { expect, it } from "vitest";
import { claimServiceNotice, SERVICE_NOTICE_DAY } from "./service-notice";
const store = () => { const values = new Map<string,string>(); return { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value); } }; };
it("suppresses a service throughout the session, including after 24 hours", () => {
  const s=store(), p=store();
  expect(claimServiceNotice("seerr",1000,s,p)).toBe(true);
  expect(claimServiceNotice("seerr",1001,s,p)).toBe(false);
  expect(claimServiceNotice("seerr",1000+SERVICE_NOTICE_DAY,s,p)).toBe(false);
});
it("suppresses fresh sessions for 24 hours, independently for each service", () => {
  const p=store();
  expect(claimServiceNotice("seerr",1000,store(),p)).toBe(true);
  expect(claimServiceNotice("seerr",1001,store(),p)).toBe(false);
  expect(claimServiceNotice("anilist",1001,store(),p)).toBe(true);
  expect(claimServiceNotice("seerr",1000+SERVICE_NOTICE_DAY,store(),p)).toBe(true);
});
