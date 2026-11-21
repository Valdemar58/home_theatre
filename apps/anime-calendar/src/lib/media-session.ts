/** Native fullscreen/PiP and OS media controls use the same room commands as the page. */
export function bindMediaSession(session: MediaSession, controls: { play: () => void; pause: () => void; seek: (to: number) => void; position: () => number; duration: () => number; rate: () => number; paused: () => boolean }) {
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => controls.play()], ["pause", () => controls.pause()],
    ["seekbackward", d => controls.seek(Math.max(0, controls.position() - (d.seekOffset ?? 10)))],
    ["seekforward", d => controls.seek(Math.min(controls.duration(), controls.position() + (d.seekOffset ?? 10)))],
    ["seekto", d => { if (typeof d.seekTime === "number") controls.seek(d.seekTime); }],
  ];
  const installed: MediaSessionAction[] = [];
  for (const [action, handler] of handlers) try { session.setActionHandler(action, handler); installed.push(action); } catch { /* Safari/OS may not expose every control. */ }
  const update = () => {
    try {
      session.playbackState = controls.paused() ? "paused" : "playing";
      const duration = controls.duration();
      if (Number.isFinite(duration) && duration > 0) session.setPositionState?.({ duration, playbackRate: controls.rate(), position: Math.max(0, Math.min(duration, controls.position())) });
    } catch { /* Unsupported native position API must not disable controls. */ }
  };
  update(); const timer = setInterval(update, 1000);
  return () => { clearInterval(timer); for (const action of installed) try { session.setActionHandler(action, null); } catch { /* unsupported */ } };
}
