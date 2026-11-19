// The local renderer owns RTC only. Files and device credentials stay in main.
const peers = new Map();
let ticking = false;
async function gather(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise(resolve => { const t = setTimeout(done, 2500); function done() { clearTimeout(t); pc.removeEventListener("icegatheringstatechange", change); resolve(); } function change() { if (pc.iceGatheringState === "complete") done(); } pc.addEventListener("icegatheringstatechange", change); });
}
async function peer(s) {
  const pc = new RTCPeerConnection({ iceServers: s.iceServers }); pc.generation = s.generation; pc.offer = s.offer; peers.set(s.id, pc);
  pc.ondatachannel = ({ channel: dc }) => {
    let busy = false;
    dc.onmessage = async ({ data }) => {
      if (busy || typeof data !== "string" || data.length > 200) return;
      busy = true;
      let request;
      try {
        request = JSON.parse(data);
        if (!Number.isSafeInteger(request.id) || request.id < 0 || request.id > 0xffffffff) throw new Error("Bad request");
        const bytes = new Uint8Array(await window.host.call("stream-read", { lease: s.id, offset: request.offset, length: request.length }));
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          const until = Date.now() + 10000;
          while (dc.bufferedAmount > 512 * 1024 && dc.readyState === "open") { if (Date.now() > until) throw new Error("Backpressure timeout"); await new Promise(r => setTimeout(r, 10)); }
          if (dc.readyState !== "open") throw new Error("Closed");
          const part = bytes.subarray(offset, offset + 16384), packet = new Uint8Array(part.length + 8);
          const view = new DataView(packet.buffer); view.setUint32(0, request.id); view.setUint32(4, offset); packet.set(part, 8); dc.send(packet);
        }
      } catch { if (dc.readyState === "open") dc.send(JSON.stringify({ error: true, id: request?.id })); }
      finally { busy = false; }
    };
  };
  try { await pc.setRemoteDescription({ type: "offer", sdp: s.offer }); await pc.setLocalDescription(await pc.createAnswer()); await gather(pc); await window.host.call("stream-answer", { lease: s.id, generation: s.generation, negotiation: s.negotiation, answer: pc.localDescription.sdp }); }
  catch { pc.close(); if (peers.get(s.id) === pc) peers.delete(s.id); }
}
setInterval(async () => {
  if (ticking) return; ticking = true;
  try {
    const streams = await window.host.call("streams");
    for (const [id, pc] of peers) if (!streams.some(s => s.id === id && s.generation === pc.generation && s.offer === pc.offer)) { pc.close(); peers.delete(id); }
    for (const s of streams) if (s.offer && !peers.has(s.id)) void peer(s);
  } finally { ticking = false; }
}, 500);
