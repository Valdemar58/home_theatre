"use client";
import { useEffect, useRef, useState } from "react";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { Button, ErrorBox } from "./ui";

/** Hidden by default; only an explicit manual-copy action reveals the secret. */
export function PrivateLink({ url, load, label = "Ссылка приглашения" }: { url?: string | null; load?: () => Promise<string>; label?: string }) {
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false), [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState(false), [manual, setManual] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (manual) { field.current?.focus(); field.current?.select(); } }, [manual]);
  const masked = `${url?.split("#")[0] || "/account/setup"}#token=********`;
  const fullLink = async () => {
    const value = load ? await load() : url;
    if (!value) throw new Error("Создайте новое приглашение.");
    return new URL(value, location.origin).href;
  };
  return <div className="space-y-2"><div className="flex min-w-0 flex-wrap items-center gap-2">
    <span aria-label={`${label}: скрыта`} className="min-w-0 flex-1 truncate rounded-lg bg-gray-900 px-3 py-2 font-mono text-xs text-gray-300">{masked}</span>
    <Button size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setCopied(false); setError(null); setBlocked(false); setManual("");
      // Start the clipboard operation inside the click gesture, before a network
      // round trip can expire activation in Safari. The token stays out of DOM.
      const value = fullLink();
      try {
        if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": value.then(text => new Blob([text], { type: "text/plain" })) })]);
        } else {
          const text = await value;
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(text);
        }
        await value; setCopied(true);
      } catch {
        try { await value; setBlocked(true); } catch (e) { setError(e); }
      } finally { setBusy(false); }
    }}><ClipboardDocumentIcon className="h-4 w-4"/>{busy ? "Копируем…" : "Копировать"}</Button>
  </div>{copied && <p role="status" className="text-xs text-emerald-300">Полная ссылка скопирована</p>}
    {blocked && !manual && <div className="space-y-2"><p role="status" className="text-sm text-gray-300">Браузер не разрешил копирование. Можно скопировать ссылку вручную.</p><Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { setManual(await fullLink()); } catch (e) { setError(e); } finally { setBusy(false); }
    }}>{busy ? "Получаем ссылку…" : "Показать полную ссылку"}</Button></div>}
    {manual && <div className="space-y-2"><label className="block space-y-1 text-xs text-gray-400"><span>Полная ссылка · выделите и скопируйте</span><textarea ref={field} aria-label={`Полная ${label.toLowerCase()}`} readOnly rows={3} value={manual} onFocus={e => e.currentTarget.select()} className="block w-full min-w-0 resize-none rounded-lg border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 focus-visible:outline-2 focus-visible:outline-accent-300" /></label><Button size="sm" variant="ghost" onClick={() => setManual("")}>Скрыть ссылку</Button></div>}
    {error ? <ErrorBox error={error}/> : null}</div>;
}
