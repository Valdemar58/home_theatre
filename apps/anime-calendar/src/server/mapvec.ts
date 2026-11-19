import "server-only";

// Контейнер mapvec (профиль mapvec): dots.mocr на видеокарте — подписи карт (/ocr), строки страниц манги (/lines),
// векторизация карт (/vectorize). Без контейнера функции работают по-старому (карта — картинкой, манга — без перевода).

const MAPVEC = (process.env.MAPVEC_URL ?? "").replace(/\/+$/, "");

let vecHealth: { ok: boolean; at: number } | null = null;
export async function mapvecUp(): Promise<boolean> {
  if (!MAPVEC) return false;
  if (vecHealth && Date.now() - vecHealth.at < 60_000) return vecHealth.ok;
  const ok = await fetch(`${MAPVEC}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  vecHealth = { ok, at: Date.now() };
  return ok;
}

export async function mapvec<T>(path: string, body: BodyInit, signal: AbortSignal): Promise<T> {
  // Без видеокарты подписи читаются минутами: ждём до получаса
  const r = await fetch(`${MAPVEC}${path}`, { method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]) });
  if (!r.ok) throw new Error(`mapvec ${path}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}
