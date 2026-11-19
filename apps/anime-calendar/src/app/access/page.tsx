"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Button } from "@/components/ui";
export default function Page() {
  const [state, setState] = useState<{ name: string; access: string } | null>(
    null,
  );
  const [error, setError] = useState(false);
  useEffect(() => {
    async function check() {
      try {
        const r = await api<{ name: string; access: string } | null>(
          "/api/auth/status",
        );
        if (!r) {
          location.href = "/login";
          return;
        }
        if (r.access === "approved") {
          location.href = "/";
          return;
        }
        setState(r);
        setError(false);
      } catch {
        setError(true);
      }
    }
    void check();
    const timer = setInterval(() => void check(), 10000);
    return () => clearInterval(timer);
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-900 px-5">
      <section className="w-full max-w-md space-y-5">
        <p className="text-sm font-semibold text-accent-200">home_theater</p>
        <h1 className="text-2xl font-semibold">
          {state?.access === "blocked" ? "Доступ отозван" : "Ожидаем одобрения"}
        </h1>
        <p className="text-sm leading-relaxed text-gray-300">
          {state?.access === "blocked"
            ? "Обратитесь к администратору. Ваши данные сохранены."
            : state
              ? `${state.name}, аккаунт создан. После одобрения администратором приложение откроется автоматически.`
              : "Проверяем состояние аккаунта…"}
        </p>
        {error && (
          <p role="status" className="text-sm text-warning-200">
            Не удалось проверить доступ. Повторим автоматически.
          </p>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST", json: {} });
            location.href = "/login";
          }}
        >
          Выйти
        </Button>
      </section>
    </main>
  );
}
