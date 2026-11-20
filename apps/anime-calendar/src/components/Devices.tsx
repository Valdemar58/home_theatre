"use client";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorBox } from "./ui";
import { useCurrentDesktop } from "./CurrentDesktopDevice";
type Device = {
  id: string;
  label: string;
  platform: string;
  online: boolean;
  revoked: number;
};
export function Devices() {
  const params = useSearchParams(),
    pair = params.get("pair"),
    qc = useQueryClient();
  const [error, setError] = useState<unknown>(null),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  const currentDesktop=useCurrentDesktop(),desktop=currentDesktop.desktop,binding=currentDesktop.data;
  const localDevice = binding?.id;
  type DesktopWindow = Window & { homeTheaterDesktop?: { linkDevice: () => Promise<{ id: string | null; status: string; active?: boolean }>; unlinkDevice: () => Promise<{ id: string | null; status: string; active?: boolean }>; deviceInfo: () => Promise<{ id: string | null; status: string; active?: boolean }> } };
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<Device[]>("/api/desktop/devices"),
    refetchInterval: 15000,
  });
  const request = useQuery({
    queryKey: ["pair", pair],
    queryFn: () =>
      api<Device>(`/api/desktop/devices?pair=${encodeURIComponent(pair!)}`),
    enabled: !!pair && !done,
    retry: false,
  });
  async function act(action: string, id: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/desktop/devices", {
        method: "POST",
        json: { action, id },
      });
      if (action === "approve") setDone(true);
      await qc.invalidateQueries({ queryKey: ["devices"] });
      const bridge = (window as DesktopWindow).homeTheaterDesktop;
      if (bridge) await qc.invalidateQueries({queryKey:['current-desktop-device']});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Мои устройства</h1>
      {desktop && !pair && binding?.status==='other-account' && <section className="space-y-3 rounded-xl bg-gray-800 p-4">
        <h2 className="text-lg font-semibold">Этот компьютер</h2>
          <p className="text-sm text-amber-300">Компьютер подключён к другому аккаунту. Сначала отвяжите его: прежний аккаунт потеряет доступ к загрузкам и раздаче на этом устройстве. Файлы сохранятся.</p>
          <Button disabled={busy || !binding} onClick={async () => {
            setBusy(true); setError(null);
            try {
              const bridge = (window as DesktopWindow).homeTheaterDesktop!;
              await bridge.unlinkDevice();
              await qc.invalidateQueries({queryKey:['current-desktop-device']});
              await qc.invalidateQueries({ queryKey: ["devices"] });
            } catch (e) { setError(e); } finally { setBusy(false); }
          }}>{busy ? "Подождите…" : "Отвязать от другого аккаунта"}</Button>
      </section>}
      <p className="text-sm text-gray-400">
        Здесь можно привязать desktop-приложение и отозвать его доступ. Загрузки
        и разрешения на раздачу комнате доступны в разделе «Загрузки».
      </p>
      {Boolean(error || devices.error) && (
        <ErrorBox error={error || devices.error} />
      )}
      {pair && !done && (
        <section className="space-y-3 rounded-xl bg-gray-800 p-4">
          <h2 className="text-lg font-semibold">Подключить устройство</h2>
          {request.error && <ErrorBox error={request.error} />}
          {request.data && (
            <>
              <p>
                {request.data.label} ·{" "}
                {request.data.platform === "win32" ? "Windows" : "Linux"}
              </p>
              <p className="break-all font-mono text-sm">{pair}</p>
              <p className="text-sm text-gray-400">
                Сверьте код с приложением на своём компьютере. Не подтверждайте
                чужой запрос.
              </p>
              <Button disabled={busy} onClick={() => act("approve", pair)}>
                Это моё устройство
              </Button>
            </>
          )}
        </section>
      )}
      {done && (
        <p role="status" className="text-emerald-300">
          Устройство привязано. Вернитесь в приложение.
        </p>
      )}
      <div className="divide-y divide-gray-700">
        {devices.data?.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-3 py-4">
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium">{d.label}{d.id === localDevice ? " · этот компьютер" : ""}</p>
              <p className="text-sm text-gray-400">
                {d.platform === "win32" ? "Windows" : "Linux"} ·{" "}
                {d.revoked
                  ? "Доступ отозван"
                  : d.online
                    ? "Подключено"
                    : "Не подключено"}
              </p>
            </div>
            {!d.revoked && (
              <Button disabled={busy} onClick={() => act("revoke", d.id)}>
                Отвязать устройство
              </Button>
            )}
          </div>
        ))}
      </div>
      {devices.data?.length === 0 && !pair && (
        <p className="text-gray-400">
          Пока нет устройств. В desktop-приложении откройте «Мои устройства» и выберите «Подключить этот компьютер».
        </p>
      )}
    </div>
  );
}
