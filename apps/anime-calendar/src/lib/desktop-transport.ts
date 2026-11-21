import { api } from "./client";
import { candidateKinds, type DirectProgress } from "./connection-diagnostics";
export type DesktopDiagnostics = { mode: "connecting" | "direct" | "relay" | "recovering" | "closed"; reason: string; notice?: string; directBytes: number; relayBytes: number; progress?: DirectProgress };
export async function connectDesktop(lease: string, report: (d: DesktopDiagnostics) => void, forceRelay = false) {
  let stopped = false, serial = 0, channel: RTCDataChannel | null = null, pc: RTCPeerConnection | null = null;
  let pending: { id: number; bytes: Uint8Array; offset: number; resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let queue = Promise.resolve();
  let generation = 1, lastNegotiation = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let initialFailure = "", relayEnabled = true;
  const lifetime = new AbortController();
  function closePeer() { const old = pc; pc = null; channel = null; old?.close(); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Соединение заменено")); pending = null; } }
  const diagnostic: DesktopDiagnostics = { mode: "connecting", reason: "Проверяем прямой канал", directBytes: 0, relayBytes: 0 };
  const progress: DirectProgress = { browser: "checking", signaling: "checking", lastSignal: 0, hostOnline: null, offerSent: false, answerReceived: false, gathering: "new", ice: "new", channel: "connecting", localCandidates: candidateKinds(), remoteCandidates: candidateKinds(), packets: 0 };
  const snapshot = () => report({ ...diagnostic, progress: { ...progress, localCandidates: { ...progress.localCandidates }, remoteCandidates: { ...progress.remoteCandidates } } });
  const publish = (mode: DesktopDiagnostics["mode"], reason: string) => { Object.assign(diagnostic, { mode, reason }); snapshot(); };
  snapshot();
  const failInitial = (reason: string) => { initialFailure = reason; closePeer(); publish("closed", reason); };
  const received = (direct: boolean, bytes: number) => { clearTimeout(initialTimer); if (direct) diagnostic.directBytes += bytes; else diagnostic.relayBytes += bytes; };
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
      try { const b = await direct(offset, length); received(true, b.byteLength); publish("direct", "Прямое соединение с хостом"); return b; }
      catch { if (!initialFailure) publish("recovering", relayEnabled ? "Прямой канал прервался; проверяем резервную передачу" : "Прямой канал прервался; восстанавливаем соединение"); }
    }
    // Keep the byte-range request open during failover. Do not replace video.src:
    // the browser can consume its existing buffer and the room barrier handles exhaustion.
    while (!stopped && !request.aborted) {
      if (initialFailure) throw new Error(initialFailure);
      if (channel?.readyState === "open") {
        try { const b = await direct(offset, length); received(true, b.byteLength); publish("direct", "Хост подключён · позиция сохранена"); return b; } catch { closePeer(); }
      }
      if (!relayEnabled) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
      try {
        const r = await fetch(`/api/desktop/media/${lease}?offset=${offset}&length=${length}`, { cache: "no-store", signal: AbortSignal.any([lifetime.signal, request, AbortSignal.timeout(18000)]) });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          if (![429, 502, 503, 504].includes(r.status)) throw Object.assign(new Error(b.error || `Ошибка ретрансляции ${r.status}`), { fatal: true });
          throw new Error(b.error || "Ожидаем хост");
        }
        const b = await r.arrayBuffer(); received(false, b.byteLength);
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
      catch (e) { if (!stopped && !request.signal.aborted) publish("closed", (e as Error).message); port.postMessage({ error: (e as Error).message }); }
      finally { clearInterval(heartbeat); port.close(); }
    });
  };
  const signal = async () => {
    try {
      const s = await api<{ answer?: string; generation: number; recovering: boolean; relayBytes?: number; relayEnabled?: boolean; iceServers: RTCIceServer[] }>(`/api/desktop/stream?lease=${lease}`, { cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
      progress.signaling = "ok"; progress.lastSignal = Date.now(); progress.hostOnline = !s.recovering; snapshot(); return s;
    } catch (e) {
      progress.signaling = ["AbortError", "TimeoutError"].includes((e as Error).name) ? "timeout" : "error"; snapshot();
      if (progress.signaling === "timeout") throw new Error(lifetime.signal.aborted ? "Подключение закрыто" : "Сервер не ответил за 10 секунд. Проверьте подключение к комнате и повторите попытку."); throw e;
    }
  };
  const initial = await signal();
  generation = initial.generation;
  relayEnabled = initial.relayEnabled !== false;
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
  if (!relayEnabled && (forceRelay || !canBridge || typeof RTCPeerConnection === "undefined")) {
    progress.browser = "unsupported";
    failInitial(forceRelay ? "Передача через сервер отключена. Откройте просмотр без параметра relay." : "Браузер не подключил прямой видеоканал. Перезагрузите страницу; серверная ретрансляция отключена.");
  } else initialTimer = setTimeout(() => {
    if (!diagnostic.directBytes && !diagnostic.relayBytes) failInitial(relayEnabled ? "Хост не начал передачу за 30 секунд. Проверьте устройство и повторите подключение." : "Прямое соединение не установлено за 30 секунд. Возможна блокировка UDP, NAT или VPN. Серверная ретрансляция отключена; попробуйте другую сеть и повторите подключение.");
  }, 30000);
  async function negotiate(iceServers: RTCIceServer[]) {
    closePeer();
    if (initialFailure || !(canBridge && !forceRelay && typeof RTCPeerConnection !== "undefined")) return;
    lastNegotiation = Date.now();
    const epoch = generation;
    Object.assign(progress, { browser: "ready", offerSent: false, answerReceived: false, gathering: "new", ice: "new", channel: "connecting", localCandidates: candidateKinds(), remoteCandidates: candidateKinds() }); snapshot();
    pc = new RTCPeerConnection({ iceServers }); channel = pc.createDataChannel("media"); channel.binaryType = "arraybuffer";
    const connection = pc;
    connection.oniceconnectionstatechange = () => { if (pc === connection) { progress.ice = connection.iceConnectionState; snapshot(); } };
    connection.onicegatheringstatechange = () => { if (pc === connection) { progress.gathering = connection.iceGatheringState; progress.localCandidates = candidateKinds(connection.localDescription?.sdp); snapshot(); } };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" && pc === connection && !stopped && !initialFailure) {
        progress.ice = "failed"; progress.channel = "closed";
        closePeer(); publish("recovering", "Прямой канал не установился · повторяем подключение");
      }
    };
    channel.onopen = () => {
      if (pc !== connection || stopped) return;
      progress.channel = "open";
      if (generation > 1) {
        diagnostic.notice = "Хост заменён · продолжаем с того же места";
        clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { diagnostic.notice = undefined; report({ ...diagnostic }); }, 6000);
      }
      publish("direct", "Прямое соединение с хостом");
    };
    channel.onclose = () => { if (!stopped && pc === connection) { progress.channel = "closed"; closePeer(); publish("recovering", "Связь с хостом потеряна · восстанавливаем передачу"); } };
    channel.onmessage = ({ data }) => {
      if (pc !== connection) return;
      const p = pending; if (!p) return;
      if (!(data instanceof ArrayBuffer) || data.byteLength < 8) { clearTimeout(p.timer); pending = null; p.reject(new Error("Хост не смог прочитать файл")); return; }
      const v = new DataView(data); if (v.getUint32(0) !== p.id || v.getUint32(4) !== p.offset || data.byteLength - 8 + p.offset > p.bytes.length) return;
      p.bytes.set(new Uint8Array(data, 8), p.offset); p.offset += data.byteLength - 8;
      if (data.byteLength > 8) {
        progress.packets++; if (progress.packets === 1) snapshot();
        clearTimeout(initialTimer); clearTimeout(p.timer);
        p.timer = setTimeout(() => { if (pending !== p) return; pending = null; closePeer(); p.reject(new Error("Прямой канал перестал передавать данные")); }, 8000);
      }
      if (p.offset === p.bytes.length) { clearTimeout(p.timer); pending = null; p.resolve(p.bytes.buffer as ArrayBuffer); }
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>(resolve => { const t = setTimeout(done, 8000); function done() { clearTimeout(t); connection.removeEventListener("icegatheringstatechange", change); resolve(); } function change() { if (connection.iceGatheringState === "complete") done(); } connection.addEventListener("icegatheringstatechange", change); if (connection.iceGatheringState === "complete") done(); });
      if (stopped || initialFailure || pc !== connection) return;
      progress.gathering = connection.iceGatheringState; progress.localCandidates = candidateKinds(connection.localDescription?.sdp); snapshot();
      await api("/api/desktop/stream", { method: "POST", json: { lease, generation: epoch, offer: connection.localDescription?.sdp }, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]) });
      progress.offerSent = true; snapshot();
    } catch { closePeer(); if (!initialFailure) publish("connecting", "Не удалось согласовать прямой канал; повторяем подключение"); }
  }
  await negotiate(initial.iceServers);
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || stopped || initialFailure) return; polling = true;
    try {
      const s = await signal(); if (stopped || initialFailure) return;
      relayEnabled = s.relayEnabled !== false;
      if (s.generation !== generation) { generation = s.generation; publish("recovering", "Переключаемся на хост с той же версией файла"); await negotiate(s.iceServers); return; }
      if (!pc && canBridge && !forceRelay && !s.recovering && Date.now() - lastNegotiation > 10000) { await negotiate(s.iceServers); return; }
      if (s.recovering) publish("recovering", "Связь с хостом потеряна · ищем доступную копию");
      if (!s.recovering && diagnostic.mode === "recovering" && Date.now() - lastNegotiation > 4000) publish("connecting", "Хост доступен · восстанавливаем прямой канал");
      if (relayEnabled && !s.recovering && !canBridge && typeof s.relayBytes === "number") { diagnostic.relayBytes = s.relayBytes; if (s.relayBytes > 0) clearTimeout(initialTimer); publish("relay", "Передача через сервер без прямого транспорта"); }
      if (s.answer && pc && !pc.remoteDescription && pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription({ type: "answer", sdp: s.answer });
        progress.answerReceived = true; progress.remoteCandidates = candidateKinds(s.answer); snapshot();
      }
    }
    // A missed coordinator poll is not evidence that the existing media channel failed.
    // Keep receiving buffered/direct media while signaling retries; room policy still
    // pauses everyone if coordination itself is lost.
    catch { if (!stopped && !initialFailure) snapshot(); }
    finally { polling = false; }
  }, 1000);
  const openingChannel = channel as RTCDataChannel | null;
  if (openingChannel && openingChannel.readyState !== "open") await new Promise<void>(resolve => { const t = setTimeout(done, 4000); function done() { clearTimeout(t); openingChannel?.removeEventListener("open", done); resolve(); } openingChannel!.addEventListener("open", done, { once: true }); });
  return () => { stopped = true; clearTimeout(initialTimer); clearTimeout(noticeTimer); lifetime.abort(); clearInterval(timer); closePeer(); navigator.serviceWorker?.removeEventListener("message", message); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Поток закрыт")); pending = null; } void fetch("/api/desktop/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close", lease }), keepalive: true }); };
}
