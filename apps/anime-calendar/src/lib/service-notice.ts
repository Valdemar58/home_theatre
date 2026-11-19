type Store = Pick<Storage, "getItem" | "setItem">;
export const SERVICE_NOTICE_DAY = 24 * 60 * 60 * 1000;
/** Claim on display, not dismissal. Session suppression survives route changes/reloads. */
export function claimServiceNotice(id: string, now: number, session: Store, persistent: Store) {
  const key = `home_theater:service-notice:v1:${id}`;
  if (session.getItem(key)) return false;
  const previous = persistent.getItem(key);
  if (previous !== null && now - Number(previous) < SERVICE_NOTICE_DAY) return false;
  session.setItem(key, "1");
  persistent.setItem(key, String(now));
  return true;
}
