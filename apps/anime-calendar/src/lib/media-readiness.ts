/** Safari may report HAVE_FUTURE_DATA while seeking with less than a frame buffered. */
export function mediaReady({ readyState, seeking, ahead, position, duration }: { readyState: number; seeking: boolean; ahead?: number; position: number; duration: number }) {
  if (seeking || readyState < 3) return false;
  if (ahead === undefined) return true;
  return ahead >= 0.1 || (Number.isFinite(duration) && position + ahead >= duration - 0.05);
}
