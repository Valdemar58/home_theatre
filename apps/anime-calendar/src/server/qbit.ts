import "server-only";

// qBittorrent WebUI API v2 — для «Подготовить серию» (скачать один файл раздачи, TASKS 9.8). Из docker-сети
// qBittorrent пускает без пароля (bootstrap.py: белый список подсети), вход по паролю — запасной путь.

const BASE = (process.env.QBIT_URL ?? "http://qbittorrent:8080").replace(/\/+$/, "");
export const PREP_CATEGORY = "stream-prep";

let sid: string | null = null;

async function call(pathname: string, init: { form?: Record<string, string>; body?: FormData } = {}, retry = true): Promise<Response> {
  const body = init.body ?? (init.form ? new URLSearchParams(init.form) : undefined);
  const res = await fetch(`${BASE}/api/v2${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { ...(sid ? { Cookie: `SID=${sid}` } : {}), Referer: BASE },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if ((res.status === 403 || res.status === 401) && retry && (await login())) return call(pathname, init, false);
  if (!res.ok) throw new Error(`qBittorrent ${pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res;
}

async function login(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/v2/auth/login`, {
    method: "POST", headers: { Referer: BASE },
    body: new URLSearchParams({ username: process.env.QBIT_USER ?? "admin", password: process.env.QBIT_PASSWORD ?? "" }),
    signal: AbortSignal.timeout(15_000),
  });
  sid = /SID=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;
  return Boolean(sid);
}

export const qbitConfigured = () => Boolean(process.env.QBIT_URL);

export type QbitTorrent = { hash: string; name: string; state: string; dlspeed: number; save_path: string; category: string };
export type QbitFile = { index: number; name: string; size: number; progress: number; priority: number };

export async function qbitTorrent(hash: string): Promise<QbitTorrent | null> {
  const list = (await (await call(`/torrents/info?hashes=${hash}`)).json()) as QbitTorrent[];
  return list[0] ?? null;
}

export async function qbitFiles(hash: string): Promise<QbitFile[]> {
  return (await (await call(`/torrents/files?hash=${hash}`)).json()) as QbitFile[];
}

/** Раздачи «Подготовить» (своя категория — Sonarr её не трогает). */
export async function qbitPrepTorrents(): Promise<QbitTorrent[]> {
  return (await (await call(`/torrents/info?category=${PREP_CATEGORY}`)).json()) as QbitTorrent[];
}

/** Добавить раздачу остановленной (чтобы до старта выбрать файлы). */
export async function qbitAdd(torrent: Uint8Array, savePath: string): Promise<void> {
  await call("/torrents/createCategory", { form: { category: PREP_CATEGORY, savePath } }).catch(() => undefined);
  const form = new FormData();
  form.append("torrents", new Blob([new Uint8Array(torrent)], { type: "application/x-bittorrent" }), "prep.torrent");
  form.append("savepath", savePath);
  form.append("category", PREP_CATEGORY);
  form.append("autoTMM", "false");
  form.append("contentLayout", "Original");
  // qBittorrent 5 — stopped, 4 — paused
  form.append("stopped", "true");
  form.append("paused", "true");
  // qBittorrent 5 отвечает JSON со счётчиками, 4 — «Ok.» / «Fails.»
  const text = (await (await call("/torrents/add", { body: form })).text()).trim();
  let failed = /^fails/i.test(text);
  try {
    failed = (JSON.parse(text) as { failure_count?: number }).failure_count! > 0;
  } catch {
    // не JSON — старый ответ
  }
  if (failed) throw new Error(`qBittorrent не принял раздачу: ${text.slice(0, 120)}`);
}

/** Приоритет файлов (0 — не качать, 1 — обычный, 7 — максимальный). */
export async function qbitFilePrio(hash: string, ids: number[], priority: number): Promise<void> {
  if (ids.length) await call("/torrents/filePrio", { form: { hash, id: ids.join("|"), priority: String(priority) } });
}

export async function qbitStart(hash: string): Promise<void> {
  // qBittorrent 5 — start, 4 — resume
  await call("/torrents/start", { form: { hashes: hash } }).catch(() => call("/torrents/resume", { form: { hashes: hash } }));
}

export async function qbitDelete(hash: string, deleteFiles: boolean): Promise<void> {
  await call("/torrents/delete", { form: { hashes: hash, deleteFiles: String(deleteFiles) } });
}
