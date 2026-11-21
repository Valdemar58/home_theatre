import { expect, it } from "vitest";
import { candidateKinds } from "./connection-diagnostics";
it("summarizes IPv4, IPv6 and mDNS candidates by type without retaining address data", () => {
  expect(candidateKinds("v=0\r\na=candidate:a 1 udp 1 private.local 123 typ host\r\na=candidate:b 1 udp 1 2001:db8::1 456 typ srflx\r\na=candidate:c 1 tcp 1 203.0.113.1 789 typ relay\r\na=candidate:d 1 udp 1 203.0.113.2 789 typ prflx\r\n")).toEqual({ host: 1, srflx: 1, relay: 1, prflx: 1 });
  expect(candidateKinds("a=ice-pwd:secret\r\na=ice-ufrag:secret\r\n")).toEqual({ host: 0, srflx: 0, prflx: 0, relay: 0 });
});
