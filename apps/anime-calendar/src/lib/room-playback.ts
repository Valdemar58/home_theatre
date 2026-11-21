import { correction, positionAt, type RoomState } from "./room";

type Media = Pick<HTMLMediaElement, "paused" | "ended" | "seeking" | "readyState" | "currentTime" | "duration" | "playbackRate" | "play" | "pause">;
type Room = { state: RoomState; canControl: boolean; serverNow: () => number; command: (action: "play" | "pause" | "seek", pos: number) => Promise<unknown> | void };

/** Distinguishes native controls from our own media events and awaits command acknowledgement. */
export class RoomPlayback {
  private expected: { playing: boolean; until: number } | null = null;
  private pending = 0;
  private serial = 0;
  private anchor = "";
  constructor(private media: () => Media | null, private room: () => Room | null | undefined, private error: (message: string) => void, private now = Date.now) {}
  async setPlaying(playing: boolean) {
    const v = this.media();
    if (!v || v.paused === !playing) return;
    this.expected = { playing, until: this.now() + 2000 };
    if (playing) await v.play().catch(() => { if (this.expected?.playing === playing) this.expected = null; });
    else v.pause();
  }
  request(action: "play" | "pause" | "seek", pos: number) {
    const r = this.room(); if (!r) return;
    const serial = ++this.serial;
    this.pending = this.now() + 5000;
    void Promise.resolve().then(() => r.command(action, pos)).catch(e => this.error((e as Error).message)).finally(() => { if (serial === this.serial) this.pending = 0; });
  }
  nativePlayback(playing: boolean, nativeFullscreen: boolean) {
    if (this.expected?.playing === playing && this.expected.until >= this.now()) { this.expected = null; return; }
    this.expected = null;
    const r = this.room(), v = this.media();
    if (!nativeFullscreen || !r || !v || v.ended || v.seeking || v.readyState < 2 || !r.canControl || (r.state.session && r.state.session.phase !== "watching")) return;
    if (r.state.playing !== playing) this.request(playing ? "play" : "pause", v.currentTime);
  }
  sync(): number | null {
    const r = this.room(), v = this.media();
    if (!r || !v || this.pending > this.now()) return null;
    const s = r.state, target = positionAt(s, r.serverNow());
    if (v.ended && (!Number.isFinite(v.duration) || target >= v.duration - 0.5)) return null;
    if (v.readyState < 2 || v.seeking) return null;
    const anchor = `${s.at}:${s.playing}`;
    // Align once at play/pause/seek, rather than taking tens of seconds to catch up
    // at 1.025x. Ordinary small clock jitter still uses gentle rate correction.
    if (this.anchor !== anchor) {
      if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = Math.max(0, target);
      this.anchor = anchor;
    }
    const drift = v.currentTime - target, c = correction(drift, s.playing);
    if (c.seek) v.currentTime = Math.max(0, target);
    if (v.playbackRate !== c.rate) v.playbackRate = c.rate;
    void this.setPlaying(s.playing);
    return drift;
  }
}
