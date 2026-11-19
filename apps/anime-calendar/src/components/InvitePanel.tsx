"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ClipboardDocumentIcon, LinkIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { INVITE_DAYS, INVITE_STATE_LABEL, type InviteView } from "@/lib/accounts";
import { api, useSharedLists } from "@/lib/client";
import { formatDate } from "@/lib/time";
import { Badge, Button, cx, ErrorBox } from "./ui";

const STATE_TONE = { active: "accent", pending: "warning", used: "positive", expired: "neutral", revoked: "neutral" } as const;

/** Ссылка в буфер; без HTTPS (дома по адресу) clipboard недоступен — выделить поле. */
async function copy(text: string, field?: HTMLInputElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.select();
    return false;
  }
}

export function InviteRow({ inv, onRevoke, from }: { inv: InviteView; onRevoke?: () => void; from?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [field, setField] = useState<HTMLInputElement | null>(null);
  return (
    <li className="space-y-2 rounded-xl bg-gray-800/50 p-3 ring-1 ring-gray-700">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATE_TONE[inv.state]}>{INVITE_STATE_LABEL[inv.state]}</Badge>
        {from && <span className="text-gray-400">от {inv.inviter.name}</span>}
        {inv.note && <span className="font-medium">{inv.note}</span>}
        {inv.group && <span className="text-gray-400">в группу «{inv.group}»</span>}
        {inv.usedBy && <span className="text-gray-400">— {inv.usedBy.name}</span>}
        <span className="ml-auto text-xs text-gray-500">
          {inv.state === "active" ? `до ${formatDate(inv.expiresAt)}` : formatDate(inv.createdAt)}
        </span>
        {onRevoke && (inv.state === "active") && (
          <button onClick={onRevoke} title="Отозвать" className="text-gray-500 hover:text-gray-200"><XMarkIcon className="h-4 w-4" /></button>
        )}
      </div>
      {inv.link && (
        <div className="flex gap-2">
          <input ref={setField} readOnly value={inv.link} onFocus={(e) => e.target.select()}
            className="min-w-0 flex-1 rounded-md bg-gray-900 px-2 py-1 font-mono text-xs text-gray-300 ring-1 ring-gray-700" />
          <Button size="sm" onClick={async () => setCopied(await copy(inv.link!, field))}>
            <ClipboardDocumentIcon className="h-4 w-4" />{copied ? "Скопировано" : "Копировать"}
          </Button>
        </div>
      )}
    </li>
  );
}

/** «Пригласить в кинотеатр»: ссылка на регистрацию; после одобрения админом — сразу в друзьях (и в группе). */
export function InvitePanel() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["invites"], queryFn: () => api<{ sso: boolean; invites: InviteView[] }>("/api/invites") });
  const { data: groups } = useSharedLists();
  const [note, setNote] = useState("");
  const [groupId, setGroupId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!data?.sso) return error ? <ErrorBox error={error} /> : null;

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/invites", { method: "POST", json: { note, groupId: groupId || undefined } });
      setNote("");
      void qc.invalidateQueries({ queryKey: ["invites"] });
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  };
  const revoke = async (id: string) => {
    await api(`/api/invites/${id}`, { method: "DELETE" });
    void qc.invalidateQueries({ queryKey: ["invites"] });
  };
  const mine = (groups ?? []).filter((g) => g.role !== "invited");
  const input = "h-9 max-w-full rounded-lg bg-gray-900 px-3 text-sm ring-1 ring-gray-700 focus:outline-none focus:ring-indigo-500";

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Пригласить в кинотеатр</h2>
      <p className="text-sm text-gray-400">
        Ссылка действует {INVITE_DAYS} дней и годится для одной регистрации. Когда админ одобрит заявку, вы сразу станете друзьями.
      </p>
      <div className="flex flex-wrap gap-2">
        <input className={cx(input, "min-w-0 flex-1")} placeholder="Для кого (видно только вам и админу)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} />
        {mine.length > 0 && (
          <select className={input} value={groupId} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Без группы</option>
            {mine.map((g) => <option key={g.id} value={g.id}>В группу «{g.name}»</option>)}
          </select>
        )}
        <Button variant="primary" disabled={busy} onClick={create}><LinkIcon className="h-4 w-4" />Создать ссылку</Button>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {data.invites.length > 0 && (
        <ul className="space-y-2">
          {data.invites.map((inv) => <InviteRow key={inv.id} inv={inv} onRevoke={() => void revoke(inv.id)} />)}
        </ul>
      )}
    </section>
  );
}
