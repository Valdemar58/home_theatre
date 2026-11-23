/** Reloading a native range response while bytes arrive can starve slow viewers forever. */
export class DesktopRecovery {
  private since: number | null = null;
  private progress = "";
  observe(now: number, eligible: boolean, progress: string) {
    if (!eligible || progress !== this.progress) { this.since = null; this.progress = progress; }
    if (!eligible) return false;
    this.since ??= now;
    if (now - this.since < 20000) return false;
    this.since = now;
    return true;
  }
}
