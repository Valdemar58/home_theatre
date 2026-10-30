"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, useMe } from "@/lib/client";
import { formatDateTime } from "@/lib/time";
import { AnilibCard } from "./AnilibCard";
import { ADMIN_NAV } from "./AppShell";
import { LlmCard } from "./LlmCard";
import { ProvidersCard } from "./books/ProvidersCard";
import { Badge, Button, ErrorBox, Skel, SkelText } from "./ui";

type SyncStats = { pushed: number; pulled: number; imported: number; removed: number; skipped: number };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-gray-800/60 p-6 ring-1 ring-gray-700">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsView() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Пока нет «me»: карточки, не зависящие от пользователя, уже настоящие (AniLib грузится сам)
  if (isLoading || !me) return (
    <div className="max-w-3xl space-y-6" aria-busy>
      <h1 className="text-2xl font-bold sm:text-3xl">Настройки</h1>
      <Card title="Shikimori"><SkelText lines={2} /><Skel className="mt-4 h-9 w-48 rounded-lg" /></Card>
      <Card title="AniLib"><AnilibCard /></Card>
      <Card title="Seerr"><SkelText lines={2} /></Card>
      <TimeCard />
    </div>
  );
  const s = me.shikimori;

  const run = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["list"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  const describe = (st: SyncStats) =>
    `Импортировано: ${st.imported}, отправлено: ${st.pushed}, обновлено: ${st.pulled}, удалено: ${st.removed}` +
    (st.skipped ? `, пропущено (нет на AniList): ${st.skipped}` : "");

  const authorize = () =>
    run("authorize", async () => {
      const { url, oob } = await api<{ url: string; oob: boolean }>("/api/shikimori/authorize");
      if (oob) {
        window.open(url, "_blank", "noopener");
        return "Разреши доступ на Shikimori, скопируй код и вставь его ниже";
      }
      window.location.href = url;
      return "";
    });

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold sm:text-3xl">Настройки</h1>
      {me.isAdmin && (
        // На телефоне нет бокового меню — служебные страницы здесь
        <div className="lg:hidden">
          <Card title="Для админа">
            <div className="flex flex-wrap gap-2">
              {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className="inline-flex items-center gap-2 rounded-md bg-gray-700/60 px-3 py-2 text-sm hover:bg-gray-700">
                  <Icon className="h-5 w-5" /> {label}
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
      {message && <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-200">{message}</div>}

      <Card title="Shikimori">
        {!s.configured ? (
          <div className="space-y-2 text-sm text-gray-300">
            <p>Синхронизация не настроена. Администратору нужно:</p>
            <ol className="list-decimal space-y-1 pl-5 text-gray-400">
              <li>Создать приложение на <a className="text-indigo-300 underline" href={`${s.url}/oauth/applications`} target="_blank" rel="noreferrer">{s.url}/oauth/applications</a> (Redirect URI — две строки: <code>https://&lt;домен&gt;/api/shikimori/callback</code> и <code>urn:ietf:wg:oauth:2.0:oob</code>, права: user_rates).</li>
              <li>Вписать <code>SHIKIMORI_CLIENT_ID</code>, <code>SHIKIMORI_CLIENT_SECRET</code> и <code>SHIKIMORI_APP_NAME</code> в .env.</li>
              <li>Перезапустить: <code>docker compose up -d anime-calendar</code>.</li>
            </ol>
          </div>
        ) : s.linked ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="positive">Привязан</Badge>
              <a href={`${s.url}/${s.nickname}`} target="_blank" rel="noreferrer" className="font-medium hover:text-indigo-300">{s.nickname}</a>
              {s.syncedAt && <span className="text-sm text-gray-400">синхронизировано {formatDateTime(s.syncedAt)}</span>}
            </div>
            {s.error && <ErrorBox error={s.error} />}
            <p className="text-sm text-gray-400">
              Изменения отправляются в Shikimori сразу, а изменения с Shikimori подтягиваются каждые 15 минут.
              Статус «Жду выхода» хранится только здесь; в Shikimori он виден как «Запланировано».
            </p>
            <div className="flex gap-2">
              <Button variant="primary" disabled={Boolean(busy)}
                onClick={() => run("sync", async () => describe(await api<SyncStats>("/api/shikimori/sync", { method: "POST" })))}>
                {busy === "sync" ? "Синхронизация…" : "Синхронизировать сейчас"}
              </Button>
              <Button variant="danger" disabled={Boolean(busy)}
                onClick={() => run("unlink", async () => {
                  await api("/api/shikimori/sync", { method: "DELETE" });
                  return "Shikimori отвязан. Локальные списки остались.";
                })}>
                Отвязать
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              Привяжи аккаунт, чтобы импортировать свои списки с Shikimori и держать их в синхронизации.
            </p>
            <Button variant="primary" onClick={authorize} disabled={Boolean(busy)}>Привязать Shikimori</Button>
            {s.oob && (
              <form className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("code", async () => {
                    const res = await api<{ nickname: string; stats: SyncStats }>("/api/shikimori/callback", { method: "POST", json: { code } });
                    setCode("");
                    return `Привязан аккаунт ${res.nickname}. ${describe(res.stats)}`;
                  });
                }}>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Код авторизации"
                  className="min-w-64 flex-1 rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                <Button type="submit" disabled={!code.trim() || Boolean(busy)}>{busy === "code" ? "Импорт…" : "Подтвердить"}</Button>
              </form>
            )}
          </div>
        )}
      </Card>

      <Card title="AniLib">
        <AnilibCard />
      </Card>

      {me.isAdmin && (
        <Card title="Провайдеры глав">
          <ProvidersCard />
        </Card>
      )}

      {me.isAdmin && (
        <Card title="ИИ">
          <LlmCard />
        </Card>
      )}

      <Card title="Seerr">
        {me.seerr.configured ? (
          <p className="text-sm text-gray-300">
            Подключён: <a className="text-indigo-300 underline" href={me.seerr.url} target="_blank" rel="noreferrer">{me.seerr.url}</a>.
            Кнопка «Запросить» отправляет аниме в Seerr, дальше Sonarr скачивает его с профилем Anime RU.
          </p>
        ) : (
          <p className="text-sm text-gray-400">
            Не настроен: нет <code>SEERR_API_KEY</code>. Запусти <code>python scripts/bootstrap.py --only anime-calendar</code>.
          </p>
        )}
      </Card>

      <TimeCard />
    </div>
  );
}

function TimeCard() {
  return (
    <Card title="Время">
      <p className="text-sm text-gray-300">
        Даты выхода показываются в часовом поясе браузера: <b>{Intl.DateTimeFormat().resolvedOptions().timeZone}</b>.
      </p>
    </Card>
  );
}
