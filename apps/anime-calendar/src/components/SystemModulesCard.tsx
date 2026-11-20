"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { api } from "@/lib/client";
import { MODULE_STATE_LABELS, SYSTEM_MODULE_IDS, type SystemModulesView } from "@/lib/system-modules";
import { Badge, Button, ErrorBox, SkelText } from "./ui";

export function SystemModulesCard() {
  const query = useQuery({
    queryKey: ["system-modules"], queryFn: () => api<SystemModulesView>("/api/admin/modules"),
    retry: false, staleTime: 30_000, refetchOnWindowFocus: false,
  });
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose flex-1 basis-64 text-sm text-gray-300">
          Планирование, аккаунты и локальная библиотека работают независимо от дополнительных компонентов.
        </p>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          {query.isFetching ? "Проверяю…" : "Проверить соединения"}
        </Button>
      </div>
      {query.isPending && <ul className="divide-y divide-gray-700/70" aria-busy="true" aria-label="Проверка компонентов">
        {SYSTEM_MODULE_IDS.map(id => <li key={id} className="py-4 first:pt-0"><SkelText lines={3} /></li>)}
      </ul>}
      {query.isError && <ErrorBox error={query.error} />}
      {query.data && (
        <>
          <ul className="divide-y divide-gray-700/70">
            {query.data.modules.map(module => (
              <li key={module.id} className="grid min-w-0 gap-2 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-sm font-medium text-gray-100">{module.name}</h3>
                    {module.version && <span className="break-all text-xs text-gray-400">{module.version}</span>}
                  </div>
                  <p className="mt-1 text-sm text-gray-400">{module.purpose}</p>
                  <p className="mt-2 text-xs leading-relaxed text-gray-300">{module.detail}</p>
                  {module.managed && <p className="mt-1 text-xs text-gray-400">Управляется установщиком сервера</p>}
                </div>
                <div className="flex items-center gap-3 self-start sm:flex-col sm:items-end">
                  <Badge tone={module.state === "available" ? "positive" : module.state === "not_configured" ? "neutral" : "warning"}>
                    {MODULE_STATE_LABELS[module.state]}
                  </Badge>
                  {module.publicUrl && module.state !== "not_configured" && (
                    <a href={module.publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 text-xs text-indigo-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-400">
                      Настройки <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-gray-400" aria-live="polite">
            Проверено в {new Date(query.data.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
            {query.data.managed ? " Состав меняется командой установщика; отключение компонента сохраняет его данные." : " Подключения заданы конфигурацией этой установки."}
          </p>
        </>
      )}
    </div>
  );
}
