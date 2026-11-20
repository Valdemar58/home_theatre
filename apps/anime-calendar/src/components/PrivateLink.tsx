"use client";
import { useState } from "react";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { Button, ErrorBox } from "./ui";

/** The secret never appears in rendered text, attributes or an input value. */
export function PrivateLink({ url, load, label = "Ссылка приглашения" }: { url?: string | null; load?: () => Promise<string>; label?: string }) {
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false), [error, setError] = useState<unknown>(null);
  const masked = `${url?.split("#")[0] || "/account/setup"}#token=********`;
  return <div className="space-y-2"><div className="flex min-w-0 flex-wrap items-center gap-2">
    <span aria-label={`${label}: скрыта`} className="min-w-0 flex-1 truncate rounded-lg bg-gray-900 px-3 py-2 font-mono text-xs text-gray-300">{masked}</span>
    <Button size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setCopied(false); setError(null);
      try {
        const value = load ? await load() : url;
        if (!value) throw new Error("Создайте новое приглашение.");
        if (!navigator.clipboard) throw new Error("Копирование доступно через HTTPS или localhost. Откройте приложение по защищённому адресу.");
        await navigator.clipboard.writeText(new URL(value, location.origin).href); setCopied(true);
      } catch (e) { setError(e); } finally { setBusy(false); }
    }}><ClipboardDocumentIcon className="h-4 w-4"/>{busy ? "Копируем…" : "Копировать"}</Button>
  </div>{copied && <p role="status" className="text-xs text-emerald-300">Полная ссылка скопирована</p>}{error ? <ErrorBox error={error}/> : null}</div>;
}
