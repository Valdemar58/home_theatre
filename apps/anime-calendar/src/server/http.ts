import "server-only";

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Последовательная очередь запросов к одному API: минимальный интервал между
 * запросами + пауза до сброса лимита, если сервер сообщил, что лимит исчерпан.
 */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private next = 0;

  constructor(private minIntervalMs: number) {}

  /** Отложить следующие запросы до момента (мс epoch). */
  pauseUntil(ts: number) {
    this.next = Math.max(this.next, ts);
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const wait = this.next - Date.now();
      if (wait > 0) await sleep(wait);
      this.next = Date.now() + this.minIntervalMs;
      return fn();
    });
    this.chain = task.catch(() => undefined);
    return task;
  }
}

/** fetch с ретраями на 429/5xx и учётом Retry-After. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  limiter: RateLimiter,
  opts: { retries?: number; timeoutMs?: number; onResponse?: (res: Response) => void } = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await limiter.run(() =>
      fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 20000), cache: "no-store" }));
    opts.onResponse?.(res);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      limiter.pauseUntil(Date.now() + delay);
      continue;
    }
    return res;
  }
}

export async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `${what}: HTTP ${res.status}`, body.slice(0, 500));
  }
  return res;
}
