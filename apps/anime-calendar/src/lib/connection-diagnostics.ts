/** Counts only: never include SDP, addresses, credentials or connection tokens in a report. */
export function candidateKinds(sdp = "") {
  const result = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const kind = line.match(/\btyp (host|srflx|prflx|relay)\b/)?.[1] as keyof typeof result | undefined;
    if (kind) result[kind]++;
  }
  return result;
}
export type RoomConnection = { transport: "connecting" | "sse" | "poll" | "offline"; lastSnapshot: number; lastError: "timeout" | "request" | null };
export type DirectProgress = {
  browser: "checking" | "ready" | "unsupported";
  signaling: "checking" | "ok" | "timeout" | "error";
  lastSignal: number;
  hostOnline: boolean | null;
  offerSent: boolean;
  answerReceived: boolean;
  gathering: string;
  ice: string;
  channel: string;
  localCandidates: ReturnType<typeof candidateKinds>;
  remoteCandidates: ReturnType<typeof candidateKinds>;
  packets: number;
};
