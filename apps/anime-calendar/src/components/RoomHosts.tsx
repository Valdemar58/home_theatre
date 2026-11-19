"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { Avatar } from "./Avatar";
import { ErrorBox, cx } from "./ui";
type File = {
  id: string;
  title: number;
  ep: number;
  bytes: number;
  state: string;
  progress: number;
};
type Host = {
  id: string;
  userId: number;
  name: string;
  label: string;
  online: boolean;
  files: File[];
};
export function RoomHosts({
  room,
  titles,
  plannedTitles,
  watched,
}: {
  room: number;
  titles: Record<number, string>;
  plannedTitles: number[];
  watched: Record<number, number[]>;
}) {
  const query = useQuery({
    queryKey: ["desktop-hosts", room],
    queryFn: () => api<Host[]>(`/api/desktop/hosts?room=${room}`),
    refetchInterval: 5000,
  });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Хосты</h2>
        <Link
          href="/devices"
          className="text-sm text-gray-400 hover:text-white"
        >
          Мои устройства
        </Link>
      </div>
      {query.error && <ErrorBox error={query.error} />}
      {query.data?.length === 0 && (
        <p className="text-sm text-gray-400">
          Нет подключённых устройств. Привяжите desktop-приложение, чтобы
          подготовить серии для комнаты.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {query.data?.map((h) => (
          <HostRow
            key={h.id}
            host={{
              ...h,
              files: h.files.filter((f) => plannedTitles.includes(f.title)),
            }}
            planned={plannedTitles.length > 0}
            watched={watched}
            titles={titles}
          />
        ))}
      </div>
    </section>
  );
}
function HostRow({
  host: h,
  titles,
  planned,
  watched,
}: {
  host: Host;
  titles: Record<number, string>;
  planned: boolean;
  watched: Record<number, number[]>;
}) {
  const [pinned, setPinned] = useState<string | null>(null),
    [hover, setHover] = useState<string | null>(null);
  const selected = h.files.find((f) => f.id === (pinned || hover));
  const titleIds = [...new Set(h.files.map((f) => f.title))];
  return (
    <article className="min-w-0 space-y-3">
      <header className="flex items-center gap-3">
        <span
          className={cx(
            "rounded-full",
            h.online &&
              "ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-900",
          )}
          aria-label={h.online ? "Хост онлайн" : "Хост офлайн"}
        >
          <Avatar user={{ id: h.userId, name: h.name }} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium">{h.name}</p>
          <p className="truncate text-xs text-gray-400">{h.label}</p>
        </div>
      </header>
      <div className="space-y-3">
        {titleIds.map((id) => (
          <div key={id}>
            <Link
              href={`/anime/${id}`}
              className="mb-2 block truncate text-sm text-gray-300 hover:text-white"
            >
              {titles[id] || `Тайтл ${id}`}
            </Link>
            <div className="flex flex-wrap gap-1.5">
              {h.files
                .filter((f) => f.title === id)
                .sort((a, b) => a.ep - b.ep)
                .map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={pinned === f.id}
                    title={
                      watched[f.title]?.includes(f.ep)
                        ? "Просмотрено группой"
                        : undefined
                    }
                    aria-label={`Серия ${f.ep}, ${f.state === "ready" ? "подготовлена" : f.state === "preparing" ? "готовится" : f.state === "error" ? "ошибка" : "файл подключён"}`}
                    onMouseEnter={() => setHover(f.id)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(f.id)}
                    onBlur={() => setHover(null)}
                    onClick={() => setPinned(pinned === f.id ? null : f.id)}
                    className={cx(
                      "h-8 min-w-8 rounded-md px-1 text-xs tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400",
                      !h.online || watched[f.title]?.includes(f.ep)
                        ? "bg-gray-700 text-gray-300"
                        : f.state === "ready"
                          ? "bg-emerald-500/20 text-emerald-200"
                          : f.state === "preparing"
                            ? "bg-accent-500/30 text-accent-200"
                            : f.state === "error"
                              ? "bg-red-500/20 text-red-200"
                              : "bg-gray-700 text-gray-200",
                      pinned === f.id && "ring-1 ring-accent-300",
                    )}
                  >
                    {f.ep}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
      <div className="min-h-20 text-xs text-gray-400" aria-live="polite">
        {selected ? (
          <>
            <p>
              Серия {selected.ep} · {(selected.bytes / 1024 ** 3).toFixed(2)} ГБ
              {!h.online && " · Хост офлайн"}
            </p>
            <div className="my-2 flex h-1 overflow-hidden rounded-full bg-gray-700">
              <span className="w-4/5 bg-accent-400" />
              <span
                className="bg-emerald-400"
                style={{
                  width: `${selected.state === "ready" ? 20 : selected.state === "preparing" ? selected.progress * 20 : 0}%`,
                }}
              />
            </div>
            <p>
              {selected.state === "ready"
                ? "Подготовлено локально"
                : selected.state === "preparing"
                  ? `Подготовка · ${Math.round(selected.progress * 100)}%`
                  : selected.state === "error"
                    ? "Файл требует проверки на устройстве"
                    : "Файл подключён, подготовка не выполнена"}
            </p>
          </>
        ) : (
          <p>
            {h.files.length
              ? `Серий: ${h.files.length} · подготовлено локально: ${h.files.filter((f) => f.state === "ready").length}`
              : planned
                ? "Нет разрешённых серий для ближайшего сеанса"
                : "Сеанс не назначен"}
            {!h.online && " · Устройство недоступно"}
          </p>
        )}
      </div>
    </article>
  );
}
