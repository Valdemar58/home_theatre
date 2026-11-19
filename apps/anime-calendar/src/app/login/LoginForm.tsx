"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, ErrorBox } from "@/components/ui";
import { api } from "@/lib/client";
import { safeNext } from "@/lib/accounts";
type TokenInfo = {
  purpose: "invite" | "claim" | "reset";
  name: string | null;
  login: string | null;
  expiresAt: number;
};
const field =
  "mt-1.5 min-h-11 w-full rounded-lg border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100 outline-none focus-visible:border-accent-400 focus-visible:ring-2 focus-visible:ring-accent-400/30";
export function LoginForm({
  mode = "login",
  next = null,
}: {
  mode?: "login" | "register" | "setup";
  next?: string | null;
}) {
  const [login, setLogin] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [token, setToken] = useState(""),
    [info, setInfo] = useState<TokenInfo | null>(null),
    [loading, setLoading] = useState(mode === "setup"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (mode !== "setup") return;
    const value =
      new URLSearchParams(location.hash.slice(1)).get("token") || "";
    setToken(value);
    history.replaceState(null, "", location.pathname);
    if (!value) {
      setError(
        new Error("Откройте полную ссылку, которую выдал администратор"),
      );
      setLoading(false);
      return;
    }
    api<TokenInfo>("/api/auth/setup", {
      method: "POST",
      json: { action: "info", token: value },
    })
      .then((v) => {
        setInfo(v);
        setLogin(v.login || "");
        setName(v.name || "");
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [mode]);
  const registration = mode === "register" || info?.purpose === "invite",
    claim = info?.purpose === "claim";
  const setting = registration || claim || info?.purpose === "reset";
  const title =
    mode === "login"
      ? "Войти"
      : registration
        ? "Создать аккаунт"
        : claim
          ? "Настроить личный аккаунт"
          : info?.purpose === "reset"
            ? "Новый пароль"
            : "Проверяем ссылку";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (setting && password !== repeat) {
      setError(new Error("Пароли не совпадают"));
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ pending?: boolean }>(
        registration
          ? "/api/auth/register"
          : mode === "setup"
            ? "/api/auth/setup"
            : "/api/auth/login",
        {
          method: "POST",
          json: { login, name, password, token: token || undefined },
        },
      );
      location.href = result.pending ? "/access" : safeNext(next);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-900 px-4 py-10">
      <div className="w-full max-w-md">
        <Link
          href="/login"
          className="mb-8 inline-flex text-sm font-semibold text-accent-200 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-300"
        >
          home_theater
        </Link>
        <h1 className="text-2xl font-semibold text-gray-100">{title}</h1>
        <p className="mb-7 mt-2 text-sm leading-relaxed text-gray-300">
          {claim
            ? "Сохранятся ваши списки, история, комнаты и привязанные устройства. Администратор останется вашей ролью."
            : registration
              ? info?.purpose === "invite"
                ? "Приглашение даст доступ сразу после регистрации."
                : "После регистрации администратор одобрит доступ."
              : "Один аккаунт для браузера и desktop."}
        </p>
        {loading ? (
          <p role="status" className="py-6 text-sm text-gray-300">
            Проверяем срок действия ссылки…
          </p>
        ) : mode === "setup" && !info ? (
          <ErrorBox error={error} />
        ) : (
          <form onSubmit={submit} className="space-y-5" aria-label={title}>
            {info?.purpose !== "reset" && (
              <label className="block text-sm text-gray-200">
                Логин
                <input
                  className={field}
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  minLength={3}
                  maxLength={40}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}"
                />
                <span className="mt-1.5 block text-xs leading-relaxed text-gray-400">
                  Латинские буквы, цифры, точка, дефис или подчёркивание.
                </span>
              </label>
            )}
            {(registration || claim) && (
              <label className="block text-sm text-gray-200">
                Ник
                <input
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                  required
                  maxLength={60}
                />
              </label>
            )}
            <label className="block text-sm text-gray-200">
              {info?.purpose === "reset" ? "Новый пароль" : "Пароль"}
              <input
                className={field}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setting ? "new-password" : "current-password"}
                required
                minLength={setting ? 12 : 1}
                maxLength={256}
              />
              {setting && (
                <span className="mt-1.5 block text-xs text-gray-400">
                  Не менее 12 символов. Можно использовать фразу.
                </span>
              )}
            </label>
            {setting && (
              <label className="block text-sm text-gray-200">
                Повторите пароль
                <input
                  className={field}
                  type="password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={12}
                />
              </label>
            )}
            {error ? (
              <div role="alert">
                <ErrorBox error={error} />
              </div>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="min-h-11 w-full"
              disabled={busy}
            >
              {busy
                ? "Сохраняем…"
                : mode === "login"
                  ? "Войти"
                  : registration
                    ? "Создать аккаунт"
                    : "Сохранить и войти"}
            </Button>
          </form>
        )}
        <div className="mt-6 space-y-4 text-sm text-gray-300">
          {mode === "login" ? (
            <>
              <p>
                Нет аккаунта?{" "}
                <Link
                  className="text-accent-200 underline-offset-4 hover:underline"
                  href="/register"
                >
                  Зарегистрироваться
                </Link>
              </p>
              <details className="text-gray-400">
                <summary className="cursor-pointer hover:text-gray-200">
                  Забыли пароль?
                </summary>
                <p className="mt-2 leading-relaxed">
                  Попросите администратора создать одноразовую ссылку
                  восстановления. Владельцу сервера доступна команда
                  восстановления.
                </p>
              </details>
            </>
          ) : (
            <Link className="text-accent-200 hover:underline" href="/login">
              Вернуться ко входу
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
