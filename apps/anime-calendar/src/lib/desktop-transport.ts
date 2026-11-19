import { api } from "./client";
export type DesktopDiagnostics = { mode: "connecting" | "direct" | "relay" | "recovering" | "closed"; reason: string; notice?: string; directBytes: number; relayBytes: number };
export async function connectDesktop(lease: string, report: (d: DesktopDiagnostics) => void, forceRelay = false) {
  let stopped = false, serial = 0, channel: RTCDataChannel | null = null, pc: RTCPeerConnection | null = null;
  let pending: { id: number; bytes: Uint8Array; offset: number; resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let queue = Promise.resolve();
  let generation = 1, lastNegotiation = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  function closePeer() { const old = pc; pc = null; channel = null; old?.close(); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Соединение заменено")); pending = null; } }
  const diagnostic: DesktopDiagnostics = { mode: "connecting", reason: "Проверяем прямой канал", directBytes: 0, relayBytes: 0 };
  const publish = (mode: DesktopDiagnostics["mode"], reason: string) => { Object.assign(diagnostic, { mode, reason }); report({ ...diagnostic }); };
  function direct(offset: number, length: number): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      if (channel?.readyState !== "open") { reject(new Error("Прямой канал недоступен")); return; }
      const id = ++serial;
      pending = { id, bytes: new Uint8Array(length), offset: 0, resolve, reject, timer: setTimeout(() => { pending = null; closePeer(); reject(new Error("Прямой канал не ответил")); }, 8000) };
      channel.send(JSON.stringify({ id, offset, length }));
    });
  }
  async function read(offset: number, length: number, request: AbortSignal) {
    if (stopped || request.aborted) throw new Error("Подключение закрыто");
    if (channel?.readyState === "open") {
      try { const b = await direct(offset, length); diagnostic.directBytes += b.byteLength; publish("direct", "Прямое соединение с хостом"); return b; }
      catch { publish("relay", "Прямой канал прервался; используется сервер"); }
    }
    // Keep the byte-range request open during failover. Do not replace video.src:
    // the browser can consume its existing buffer and the room barrier handles exhaustion.
    while (!stopped && !request.aborted) {
      if (channel?.readyState === "open") {
        try { const b = await direct(offset, length); diagnostic.directBytes += b.byteLength; publish("direct", "Хост подключён · позиция сохранена"); return b; } catch { closePeer(); }
      }
      try {
        const r = await fetch(`/api/desktop/media/${lease}?offset=${offset}&length=${length}`, { cache: "no-store", signal: AbortSignal.any([lifetime.signal, request, AbortSignal.timeout(18000)]) });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          if (![429, 502, 503, 504].includes(r.status)) throw Object.assign(new Error(b.error || `Ошибка ретрансляции ${r.status}`), { fatal: true });
          throw new Error(b.error || "Ожидаем хост");
        }
        const b = await r.arrayBuffer(); diagnostic.relayBytes += b.byteLength;
        publish("relay", generation > 1 ? "Хост автоматически заменён · позиция сохранена" : forceRelay ? "Ретрансляция выбрана для диагностики" : "Передача через сервер"); return b;
      } catch (e) {
        if (stopped || request.aborted || (e as { fatal?: boolean }).fatal) throw e;
        publish("recovering", "Связь с хостом потеряна · ищем доступную копию");
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw new Error("Подключение закрыто");
  }

  const message = (e: MessageEvent) => {
    if (e.data?.type !== "desktop-range" || e.data.lease !== lease || !e.ports[0]) return;
    const { offset, length } = e.data, port = e.ports[0];
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > 1024 * 1024) { port.postMessage({ error: "Некорректный диапазон" }); return; }
    const request = new AbortController();
    port.onmessage = e => { if (e.data?.cancel) request.abort(); };
    const heartbeat = setInterval(() => port.postMessage({ waiting: true }), 5000);
    queue = queue.catch(() => {}).then(async () => {
      try { const bytes = await read(offset, length, request.signal); port.postMessage({ bytes }, [bytes]); }
      catch (e) { if (!request.signal.aborted) publish("closed", (e as Error).message); port.postMessage({ error: (e as Error).message }); }
      finally { clearInterval(heartbeat); port.close(); }
    });
  };
  const signal = () => api<{ answer?: string; generation: number; recovering: boolean; relayBytes?: number; iceServers: RTCIceServer[] }>(`/api/desktop/stream?lease=${lease}`);
  const initial = await signal();
  generation = initial.generation;
  let canBridge = false;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.addEventListener("message", message);
    try {
      await navigator.serviceWorker.register("/desktop-stream-sw.js", { scope: "/" });
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Service worker timeout")), 5000))]);
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => { const t = setTimeout(done, 2000); function done() { clearTimeout(t); navigator.serviceWorker.removeEventListener("controllerchange", done); resolve(); } navigator.serviceWorker.addEventListener("controllerchange", done, { once: true }); });
      canBridge = Boolean(navigator.serviceWorker.controller);
    } catch { /* Native HTTP Range relay remains available without a service worker. */ }
  }
  async function negotiate(iceServers: RTCIceServer[]) {
    closePeer();
    if (!(canBridge && !forceRelay && typeof RTCPeerConnection !== "undefined")) return;
    lastNegotiation = Date.now();
    const epoch = generation;
    pc = new RTCPeerConnection({ iceServers }); channel = pc.createDataChannel("media"); channel.binaryType = "arraybuffer";
    const connection = pc;
    channel.onopen = () => {
      if (pc !== connection || stopped) return;
      if (generation > 1) {
        diagnostic.notice = "Хост заменён · продолжаем с того же места";
        clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { diagnostic.notice = undefined; report({ ...diagnostic }); }, 6000);
      }
      publish("direct", "Прямое соединение с хостом");
    };
    channel.onclose = () => { if (!stopped && pc === connection) { closePeer(); publish("recovering", "Связь с хостом потеряна · восстанавливаем передачу"); } };
    channel.onmessage = ({ data }) => {
      if (pc !== connection) return;
      const p = pending; if (!p) return;
      if (!(data instanceof ArrayBuffer) || data.byteLength < 8) { clearTimeout(p.timer); pending = null; p.reject(new Error("Хост не смог прочитать файл")); return; }
      const v = new DataView(data); if (v.getUint32(0) !== p.id || v.getUint32(4) !== p.offset || data.byteLength - 8 + p.offset > p.bytes.length) return;
      p.bytes.set(new Uint8Array(data, 8), p.offset); p.offset += data.byteLength - 8;
      if (p.offset === p.bytes.length) { clearTimeout(p.timer); pending = null; p.resolve(p.bytes.buffer as ArrayBuffer); }
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>(resolve => { const t = setTimeout(done, 2000); function done() { clearTimeout(t); resolve(); } connection.onicegatheringstatechange = () => { if (connection.iceGatheringState === "complete") done(); }; if (connection.iceGatheringState === "complete") done(); });
      await api("/api/desktop/stream", { method: "POST", json: { lease, generation: epoch, offer: connection.localDescription?.sdp } });
    } catch { closePeer(); publish("relay", "Не удалось согласовать прямой канал"); }
  }
  await negotiate(initial.iceServers);
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || stopped) return; polling = true;
    try { const s = await signal(); if (s.generation !== generation) { generation = s.generation; publish("recovering", "Переключаемся на хост с той же версией файла"); await negotiate(s.iceServers); return; } if (!pc && canBridge && !forceRelay && !s.recovering && Date.now() - lastNegotiation > 10000) { await negotiate(s.iceServers); return; } if (s.recovering) publish("recovering", "Связь с хостом потеряна · ищем доступную копию"); if (!s.recovering && diagnostic.mode === "recovering" && Date.now() - lastNegotiation > 4000) publish("relay", "Хост доступен · передача через сервер"); if (!s.recovering && !canBridge && typeof s.relayBytes === "number") { diagnostic.relayBytes = s.relayBytes; publish("relay", "Передача через сервер без прямого транспорта"); } if (s.answer && pc && !pc.remoteDescription && pc.signalingState === "have-local-offer") await pc.setRemoteDescription({ type: "answer", sdp: s.answer }); }
    catch (e) { closePeer(); publish("closed", (e as Error).message); }
    finally { polling = false; }
  }, 1000);
  const openingChannel = channel as RTCDataChannel | null;
  if (openingChannel && openingChannel.readyState !== "open") await new Promise<void>(resolve => { const t = setTimeout(done, 4000); function done() { clearTimeout(t); openingChannel?.removeEventListener("open", done); resolve(); } openingChannel!.addEventListener("open", done, { once: true }); });
  return () => { stopped = true; clearTimeout(noticeTimer); lifetime.abort(); clearInterval(timer); closePeer(); navigator.serviceWorker?.removeEventListener("message", message); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Поток закрыт")); pending = null; } void fetch("/api/desktop/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close", lease }), keepalive: true }); };
}
