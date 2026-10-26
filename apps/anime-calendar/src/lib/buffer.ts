// Готовность серии к просмотру из торрента без остановок.
//
// Серия читается с начала: в буфере B байт (непрерывно от начала), осталось докачать R,
// качаем со скоростью v, плеер тратит r байт/с (размер ÷ длительность).
// Начали смотреть сейчас: просмотр догонит загрузку в момент B / (r − v), загрузка
// закончится через R / v. Остановок не будет, если загрузка успевает раньше:
//   v ≥ r                 — хватает самой скорости;
//   B / (r − v) ≥ R / v   ⇔  v·B ≥ (r − v)·R.
// Когда станет можно (B и R меняются со скоростью v): t ≥ ((r − v)·R − v·B) / (v·r).

/** Запас к скорости просмотра: битрейт неровный (сцены с движением тяжелее). */
export const RATE_MARGIN = 1.2;
/** Минимум в буфере перед стартом: столько секунд видео — иначе плеер долго «думает». */
export const MIN_START_SEC = 20;

export type BufferInput = {
  size: number;
  /** Сколько уже есть подряд с начала файла */
  read: number;
  /** Сглаженная скорость загрузки, байт/с */
  speed: number;
  /** Сколько байт в секунду тратит просмотр (размер ÷ длительность) */
  rate: number;
};

export type Readiness = { ready: boolean; etaSec: number | null };

export function readiness({ size, read, speed, rate }: BufferInput): Readiness {
  const left = size - read;
  if (left <= 0) return { ready: true, etaSec: 0 };
  const r = rate * RATE_MARGIN;
  const minStart = Math.min(size, rate * MIN_START_SEC);
  if (speed <= 0) return { ready: false, etaSec: null };
  const startWait = Math.max(0, (minStart - read) / speed);
  if (speed >= r) return { ready: startWait === 0, etaSec: startWait };
  if (speed * read >= (r - speed) * left) return { ready: startWait === 0, etaSec: startWait };
  const t = ((r - speed) * left - speed * read) / (speed * r);
  return { ready: false, etaSec: Math.max(t, startWait) };
}

/** Сглаживание скорости: экспоненциально затухающее среднее (свежие замеры весят больше). */
export const ewma = (prev: number | null, sample: number, alpha = 0.2) => (prev === null ? sample : alpha * sample + (1 - alpha) * prev);
