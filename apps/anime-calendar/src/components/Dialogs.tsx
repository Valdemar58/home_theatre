"use client";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Button, Modal } from "./ui";

// Подтверждения и сообщения об ошибках — своими окнами (системные confirm/alert не используем:
// они блокируют страницу, выглядят чужеродно и не стилизуются). Promise-API, как у confirm:
//   const confirm = useConfirm();  if (!(await confirm({ title: "Удалить?", danger: true }))) return;
//   const alert = useAlert();      alert({ title: "Не получилось", text: e.message });

type ConfirmOpts = { title: string; text?: React.ReactNode; confirm?: string; cancel?: string; danger?: boolean };
type AlertOpts = { title: string; text?: React.ReactNode };
type Pending = { kind: "confirm"; opts: ConfirmOpts } | { kind: "alert"; opts: AlertOpts };

const Ctx = createContext<{ ask: (p: Pending) => Promise<boolean> } | null>(null);

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolve = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback((p: Pending) => new Promise<boolean>((res) => {
    resolve.current?.(false);
    resolve.current = res;
    setPending(p);
  }), []);
  const close = useCallback((v: boolean) => {
    resolve.current?.(v);
    resolve.current = null;
    setPending(null);
  }, []);
  const onClose = useCallback(() => close(false), [close]);

  return (
    <Ctx.Provider value={{ ask }}>
      {children}
      <Modal open={Boolean(pending)} onClose={onClose} title={pending?.opts.title ?? ""}>
        {pending && (
          <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); close(true); }}>
            {pending.kind === "alert" && (
              <div className="flex gap-3">
                <ExclamationTriangleIcon className="h-6 w-6 shrink-0 text-negative-300" />
                {pending.opts.text && <div className="text-sm leading-relaxed text-gray-300">{pending.opts.text}</div>}
              </div>
            )}
            {pending.kind === "confirm" && pending.opts.text && <div className="text-sm leading-relaxed text-gray-300">{pending.opts.text}</div>}
            <div className="flex justify-end gap-2">
              {pending.kind === "confirm" && <Button type="button" variant="ghost" onClick={onClose}>{pending.opts.cancel ?? "Отмена"}</Button>}
              <Button type="submit" autoFocus variant={pending.kind === "confirm" && pending.opts.danger ? "danger" : "primary"}>
                {pending.kind === "confirm" ? (pending.opts.confirm ?? "Да") : "Понятно"}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </Ctx.Provider>
  );
}

function useDialogs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("DialogsProvider не подключён");
  return ctx;
}

export function useConfirm() {
  const { ask } = useDialogs();
  return useCallback((opts: ConfirmOpts) => ask({ kind: "confirm", opts }), [ask]);
}

export function useAlert() {
  const { ask } = useDialogs();
  return useCallback((opts: AlertOpts) => void ask({ kind: "alert", opts }), [ask]);
}
