"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Account, AccountsView as View } from "@/lib/accounts";
import { api, useMe } from "@/lib/client";
import { Button, Badge, ErrorBox, Skel } from "./ui";
import { Avatar } from "./Avatar";
import { InvitePanel } from "./InvitePanel";
import { useConfirm } from "./Dialogs";
export function AccountsView() {
  const qc = useQueryClient(),
    confirm = useConfirm();
  const { data: me } = useMe();
  const { data, error, isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<View>("/api/accounts"),
    refetchInterval: 15000,
  });
  const [busy, setBusy] = useState<number | null>(null),
    [failure, setFailure] = useState<unknown>(null),
    [link, setLink] = useState<{ name: string; url: string } | null>(null);
  async function act(a: Account, action: string) {
    if (
      ["block", "friend", "revoke-sessions"].includes(action) &&
      !(await confirm({
        title:
          action === "block"
            ? `Отозвать доступ ${a.name}?`
            : `Изменить доступ ${a.name}?`,
        text: "Данные, история и привязанные устройства сохранятся. Текущие входы будут завершены.",
        confirm: "Продолжить",
        danger: action === "block",
      }))
    )
      return;
    setBusy(a.id);
    setFailure(null);
    setLink(null);
    try {
      const r = await api<{ link?: string }>(`/api/accounts/${a.id}`, {
        method: "POST",
        json: { action },
      });
      if (r.link) {
        if (action === "claim" && a.id === me?.id) {
          location.href = r.link;
          return;
        }
        setLink({ name: a.name, url: new URL(r.link, location.origin).href });
      }
      if (a.id === me?.id && action === "revoke-sessions") {
        location.href = "/login";
        return;
      }
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(null);
    }
  }
  async function decide(id: number, approve: boolean) {
    setBusy(id);
    setFailure(null);
    try {
      await api(`/api/accounts/requests/${id}`, {
        method: "POST",
        json: { approve },
      });
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(null);
    }
  }
  if (isLoading) return <Skel className="h-40" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h2 className="text-lg font-semibold">Аккаунты и доступ</h2>
        <p className="text-sm leading-relaxed text-gray-300">
          Регистрация без приглашения требует вашего одобрения. Приглашение
          сразу открывает доступ. Аккаунты принадлежат home_theater.
        </p>
      </div>
      {failure ? <ErrorBox error={failure} /> : null}
      {link && (
        <section
          className="space-y-2 rounded-xl bg-gray-800 p-4"
          aria-label="Одноразовая ссылка"
        >
          <h3 className="text-sm font-semibold">Ссылка для {link.name}</h3>
          <p className="text-xs leading-relaxed text-gray-300">
            Передайте её владельцу аккаунта. Скопируйте сейчас: после обновления
            страницы ссылка не будет показана повторно. Новая ссылка отменит
            предыдущую.
          </p>
          <input
            aria-label="Ссылка настройки аккаунта"
            readOnly
            value={link.url}
            onFocus={(e) => e.target.select()}
            className="min-h-11 w-full min-w-0 rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm"
          />
        </section>
      )}
      {data.requests.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-base font-semibold">
            Ожидают одобрения · {data.requests.length}
          </h3>
          <ul className="divide-y divide-gray-700">
            {data.requests.map((r) => (
              <li
                key={r.authPk}
                className="flex flex-wrap items-center gap-3 py-4"
              >
                <div className="min-w-0 flex-1 break-words text-sm">
                  {r.username}
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void decide(r.authPk, true)}
                >
                  Одобрить
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void decide(r.authPk, false)}
                >
                  Отклонить
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-3">
        <h3 className="text-base font-semibold">
          Пользователи · {data.accounts.length}
        </h3>
        <ul className="divide-y divide-gray-700">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start gap-3 py-4">
              <Avatar
                user={{ id: a.id, name: a.name }}
                className="h-8 w-8 text-sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium">
                    {a.name}
                  </span>
                  {a.id === me?.id && (
                    <span className="text-xs text-gray-400">ваш аккаунт</span>
                  )}
                  {a.admin && <Badge>Администратор</Badge>}
                  {a.blocked && <Badge tone="negative">Доступ отозван</Badge>}
                </div>
                <p className="mt-1 text-xs text-gray-400">
                  {a.linked
                    ? "Локальный аккаунт"
                    : "Нужно задать логин и пароль"}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-2 gap-y-2">
                  {!a.linked ? (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void act(a, "claim")}
                    >
                      {a.id === me?.id
                        ? "Настроить мой аккаунт"
                        : "Создать ссылку настройки"}
                    </Button>
                  ) : (
                    <>
                      {!a.blocked && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void act(a, "reset")}
                          >
                            Восстановить пароль
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void act(a, "revoke-sessions")}
                          >
                            Завершить входы
                          </Button>
                        </>
                      )}
                      {a.id !== me?.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(a, a.blocked ? "unblock" : "block")
                          }
                        >
                          {a.blocked ? "Вернуть доступ" : "Отозвать доступ"}
                        </Button>
                      )}
                    </>
                  )}
                  {a.id !== me?.id && !a.blocked && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(a, a.admin ? "friend" : "admin")}
                    >
                      {a.admin
                        ? "Снять роль администратора"
                        : "Сделать администратором"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <InvitePanel />
    </div>
  );
}
