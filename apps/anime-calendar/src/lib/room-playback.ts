import { positionAt, type RoomState } from "./room";
import { DEFAULT_SYNC_POLICY, syncCorrection, type SyncPolicy } from "./sync-policy";
import { mediaReady } from "./media-readiness";

type Media = Pick<HTMLMediaElement, "paused" | "ended" | "seeking" | "readyState" | "currentTime" | "duration" | "playbackRate" | "play" | "pause"> & { buffered?: TimeRanges };
type Room = { policy?: SyncPolicy; state: RoomState; canControl: boolean; serverNow: () => number; command: (action: "play" | "pause" | "seek", pos: number) => Promise<unknown> | void };

/** Distinguishes native controls from our own media events and awaits command acknowledgement. */
export class RoomPlayback {
  private expected: { playing: boolean; until: number } | null = null;
  private pending = 0;
  private serial = 0;
  private anchor = "";
  private seekExpected: number | null = null;
  private desired: boolean | null = null;
  private commands: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private starting = false;
  constructor(private media: () => Media | null, private room: () => Room | null | undefined, private error: (message: string) => void, private now = Date.now, private blockedChanged: (value: boolean) => void = () => {}) {}
  async setPlaying(playing: boolean, userGesture = false) {
    const v = this.media();
    if (!v || v.paused === !playing) return;
    if (playing && (this.starting || (this.blocked && !userGesture))) return;
    if (playing && userGesture && this.blocked && v.readyState >= 2) {
      const r = this.room(); if (r?.state.playing) this.setPosition(positionAt(r.state, r.serverNow()));
    }
    this.expected = { playing, until: this.now() + 2000 };
    if (playing) {
      this.starting = true;
      try { await v.play(); this.blocked = false; this.blockedChanged(false); }
      catch (e) {
        if (this.expected?.playing === playing) this.expected = null;
        if ((e as Error).name === "NotAllowedError") { this.blocked = true; this.blockedChanged(true); }
        else if ((e as Error).name !== "AbortError") this.error((e as Error).message);
      } finally { this.starting = false; }
    } else v.pause();
  }
  request(action: "play" | "pause" | "seek", pos: number) {
    const r = this.room(); if (!r) return;
    const serial = ++this.serial;
    if (action !== "seek") this.desired = action === "play";
    this.pending = this.now() + 5000;
    this.commands = this.commands.then(() => r.command(action, pos)).catch(e => this.error((e as Error).message)).finally(() => { if (serial === this.serial) { this.pending = 0; this.desired = null; } });
  }
  transition() { this.pending = this.now() + 500; }
  endFullscreen(pictureInPicture = false) {
    if (pictureInPicture) { if (this.desired === null) this.pending = 0; return; }
    const r = this.room(), v = this.media();
    if (r?.canControl && v && !v.ended && r.state.playing && (!r.state.session || r.state.session.phase === "watching")) {
      if (this.desired !== false) this.request("pause", v.currentTime);
      void this.setPlaying(false);
    } else if (this.desired === null) this.pending = 0;
  }
  setPosition(pos: number) {
    const v = this.media(); if (!v) return;
    this.seekExpected = Math.max(0, Math.min(pos, Number.isFinite(v.duration) ? v.duration - 0.1 : pos));
    v.currentTime = this.seekExpected;
  }
  nativeSeek(active: boolean) {
    const v = this.media(), r = this.room(); if (!v) return;
    if (this.seekExpected !== null && Math.abs(this.seekExpected - v.currentTime) < 0.2) { this.seekExpected = null; return; }
    this.seekExpected = null;
    if (active && r?.canControl && (!r.state.session || r.state.session.phase === "watching")) this.request("seek", v.currentTime);
  }
  nativePlayback(playing: boolean, nativeFullscreen: boolean) {
    if (this.expected?.playing === playing && this.expected.until >= this.now()) { this.expected = null; return; }
    this.expected = null;
    const r = this.room(), v = this.media();
    if (!nativeFullscreen || !r || !v || v.ended || v.seeking || v.readyState < 2 || !r.canControl || (r.state.session && r.state.session.phase !== "watching")) return;
    if (r.state.playing !== playing || (this.desired !== null && this.desired !== playing)) this.request(playing ? "play" : "pause", v.currentTime);
  }
  sync(): number | null {
    const r = this.room(), v = this.media();
    if (!r || !v || this.pending > this.now()) return null;
    const s = r.state, target = positionAt(s, r.serverNow());
    if (v.ended && (!Number.isFinite(v.duration) || target >= v.duration - 0.5)) return null;
    if (v.readyState < 2 || v.seeking) return null;
    // A paused element whose play() was denied cannot catch up. Seeking it every
    // hardSeek seconds only displays isolated frames and never starts its audio.
    if (s.playing && v.paused) { void this.setPlaying(true); return v.currentTime - target; }
    if (!v.paused && this.blocked) { this.blocked = false; this.blockedChanged(false); }
    let ahead: number | undefined;
    if (v.buffered) {
      ahead = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
    }
    if (s.playing && !mediaReady({ readyState: v.readyState, seeking: v.seeking, ahead, position: v.currentTime, duration: v.duration })) { v.playbackRate = 1; return v.currentTime - target; }
    const anchor = `${s.at}:${s.playing}`, policy = r.policy ?? DEFAULT_SYNC_POLICY;
    // Pauses align immediately. Playback catches up according to the room policy;
    // only a large discontinuity requires a seek.
    if (this.anchor !== anchor) {
      if (Math.abs(v.currentTime - target) > (s.playing ? policy.hardSeek : policy.tolerance)) this.setPosition(target);
      this.anchor = anchor;
    }
    const drift = v.currentTime - target, c = syncCorrection(drift, s.playing, policy);
    if (c.seek) this.setPosition(target);
    // Accelerating a nearly empty buffer creates the very stalls we are correcting.
    if (c.rate > 1 && ahead !== undefined && ahead < 2) c.rate = 1;
    if (v.playbackRate !== c.rate) v.playbackRate = c.rate;
    void this.setPlaying(s.playing);
    return drift;
  }
}
