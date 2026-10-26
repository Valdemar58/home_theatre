"use client";
import { useState } from "react";
import { Button, ErrorBox } from "@/components/ui";
import { api } from "@/lib/client";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { username, password } });
      window.location.href = "/calendar";
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const input =
    "mt-1 w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.25),transparent_60%)]" />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-indigo-600 to-purple-600 text-2xl font-black">A</span>
          <h1 className="text-2xl font-bold">Аниме-календарь</h1>
          <p className="text-sm text-gray-400">Войди с учётной записью Jellyfin</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl bg-gray-800/80 p-6 shadow-xl ring-1 ring-gray-700 backdrop-blur">
          <label className="block text-sm font-medium text-gray-300">
            Имя пользователя
            <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          </label>
          <label className="block text-sm font-medium text-gray-300">
            Пароль
            <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {error ? <ErrorBox error={error} /> : null}
          <Button variant="primary" type="submit" disabled={busy || !username} className="w-full">
            {busy ? "Вход…" : "Войти"}
          </Button>
        </form>
      </div>
    </div>
  );
}
