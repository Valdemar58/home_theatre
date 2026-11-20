import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./books/provider-config", () => ({ providerConfig: () => ({ suwayomi: { url: "" } }) }));
import { probeModule } from "./system-modules";
import { integrationCapabilities } from "@/lib/system-modules";

const probe = { id: "search", name: "Поиск", purpose: "Поиск", url: "http://indexer:9696", path: "/api/v1/indexer", requiresKey: true, key: "private-test-key", inspect: "indexers" as const };
it("search works with Prowlarr alone while legacy media actions remain unavailable", () => {
  expect(integrationCapabilities({prowlarrUrl:probe.url,prowlarrApiKey:probe.key,sonarrUrl:"",sonarrApiKey:"",jellyfinUrl:"",jellyfinApiKey:"",torrserverUrl:""}))
    .toEqual({search:true,serverDownload:false,serverStream:false});
});
it("unconfigured modules cause no network requests", async () => {
  const fetcher = vi.fn();
  expect((await probeModule({...probe,url:""},fetcher)).state).toBe("not_configured");
  expect((await probeModule({...probe,key:""},fetcher)).state).toBe("needs_setup");
  expect(fetcher).not.toHaveBeenCalled();
});
it("distinguishes a running indexer service from configured search", async () => {
  expect((await probeModule(probe,vi.fn().mockResolvedValue(Response.json([])))).state).toBe("needs_setup");
  const result=await probeModule(probe,vi.fn().mockResolvedValue(Response.json([{enable:true},{enable:false}])));
  expect(result.state).toBe("available");
  expect(result.detail).toContain("1");
  expect(JSON.stringify(result)).not.toContain(probe.key);
});
it("does not disclose upstream errors, credential-bearing URLs or public URL query tokens", async () => {
  const failed=await probeModule({...probe,publicUrl:'https://example.org/?apikey=hidden'},vi.fn().mockRejectedValue(new Error('private-test-key hidden')));
  expect(failed.state).toBe("unreachable");
  expect(JSON.stringify(failed)).not.toMatch(/private-test-key|hidden/);
  const fetcher=vi.fn();
  expect((await probeModule({...probe,url:'http://name:secret@example.org'},fetcher)).state).toBe("needs_setup");
  expect(fetcher).not.toHaveBeenCalled();
});
it("reports rejected authorization and malformed responses separately from availability", async () => {
  expect((await probeModule(probe,vi.fn().mockResolvedValue(new Response(null,{status:401})))).state).toBe("unauthorized");
  expect((await probeModule(probe,vi.fn().mockResolvedValue(Response.json({error:'bad'})))).state).toBe("unreachable");
});
it("a running Ollama without models does not imply AI readiness", async () => {
  const modelProbe={...probe,inspect:'models' as const};
  expect((await probeModule(modelProbe,vi.fn().mockResolvedValue(Response.json({models:[]})))).state).toBe("needs_setup");
  expect((await probeModule(modelProbe,vi.fn().mockResolvedValue(Response.json({models:[{name:'example'}]})))).state).toBe("available");
});
