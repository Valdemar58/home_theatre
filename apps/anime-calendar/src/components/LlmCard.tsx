"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { LLM_TASKS, TASK_LABELS, type LlmMode, type LlmSettings, type LlmStatus, type LlmTask, type LlmUsageRow, type Pool } from "@/lib/llm-tasks";
import { useConfirm } from "./Dialogs";
import { Badge, Button, cx, ErrorBox, Segmented, Skel } from "./ui";

// Настройки ИИ (для админа): режим, какие задачи идут во внешний API (DeepSeek), бюджет и расход.
// Ключ API — только в .env: здесь видно, задан ли он.

type TestResult = { ok: boolean; model: string; ms: number; usage: { prompt: number; completion: number } | null; costUsd: number; error: string | null };

const MODES: [LlmMode, string][] = [["auto", "Авто"], ["local", "Только локально"], ["external", "Всё внешнее"], ["off", "Без ИИ"]];
const MODE_HINT: Record<LlmMode, string> = {
  auto: "задачи идут туда, куда назначены ниже; без ключа, денег или связи — локально",
  local: "только видеокарта (Ollama)",
  external: "все задачи — во внешний API, локальная модель — запасная",
  off: "ИИ выключен: рекомендации и «похожее» работают по тегам и оценкам",
};
const POOLS: [Pool, string][] = [["local", "Локально"], ["cheap", "Дёшево"], ["smart", "Умно"]];
const usd = (x: number) => (x < 0.01 && x > 0 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("ru-RU"));

export function LlmCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: st, isLoading } = useQuery({ queryKey: ["llm"], queryFn: () => api<LlmStatus>("/api/llm/settings") });
  const { data: usage } = useQuery({ queryKey: ["llm-usage"], queryFn: () => api<LlmUsageRow[]>("/api/llm/usage") });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState({ cheap: "", smart: "", budget: "" });
  const [test, setTest] = useState<Record<string, TestResult | "…">>({});

  useEffect(() => {
    if (st) setModels({ cheap: st.settings.cheap, smart: st.settings.smart, budget: String(st.settings.budgetUsd) });
  }, [st]);

  const save = async (patch: Partial<LlmSettings>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(["llm"], await api<LlmStatus>("/api/llm/settings", { method: "PUT", json: patch }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const runTest = async (pool: Pool) => {
    setTest((t) => ({ ...t, [pool]: "…" }));
    const r = await api<TestResult>("/api/llm/test", { method: "POST", json: { pool } }).catch((e) => ({
      ok: false, model: "", ms: 0, usage: null, costUsd: 0, error: e instanceof Error ? e.message : String(e),
    }));
    setTest((t) => ({ ...t, [pool]: r }));
    void qc.invalidateQueries({ queryKey: ["llm-usage"] });
    void qc.invalidateQueries({ queryKey: ["llm"] });
  };

  if (isLoading || !st) return <LlmCardSkeleton />;
  const s = st.settings;
  const spentShare = st.month.budget > 0 ? Math.min(1, st.month.spent / st.month.budget) : 1;

  return (
    <div className="space-y-5 text-sm">
      {error ? <ErrorBox error={error} /> : null}

      <div className="flex flex-wrap gap-2">
        <Badge tone={st.ollama.chat ? "positive" : "negative"}>Ollama {st.ollama.model}: {st.ollama.chat ? "готова" : "нет"}</Badge>
        <Badge tone={st.ollama.embed ? "positive" : "negative"}>Эмбеддинги {st.ollama.embedModel}: {st.ollama.embed ? "готовы" : "нет"}</Badge>
        <Badge tone={st.key.set ? "positive" : "neutral"}>{st.key.set ? `Ключ API задан …${st.key.tail}` : "Ключ API не задан"}</Badge>
        {st.external.breaker && <Badge tone="warning">Внешний API на паузе: {st.external.breaker}</Badge>}
      </div>
      {!st.key.set && (
        <p className="text-gray-400">
          Внешний API (DeepSeek) включается ключом <code>DEEPSEEK_API_KEY</code> в .env и перезапуском:{" "}
          <code>docker compose up -d anime-calendar</code>. Без ключа всё считается локально.
        </p>
      )}

      <div className="space-y-2">
        <Segmented value={s.mode} onChange={(mode) => void save({ mode })} options={MODES} />
        <p className="text-gray-400">{MODE_HINT[s.mode]}</p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-gray-300">Расход в этом месяце</span>
          <span className="whitespace-nowrap tabular-nums text-gray-300">{usd(st.month.spent)} из {usd(st.month.budget)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-700">
          <div className={cx("h-full rounded-full", spentShare >= 1 ? "tone-negative solid" : spentShare > 0.8 ? "tone-warning solid" : "tone-accent solid")}
            style={{ width: `${spentShare * 100}%` }} />
        </div>
        <p className="text-xs text-gray-500">Бюджет исчерпан — задачи до конца месяца идут локально.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault();
        void save({ cheap: models.cheap.trim(), smart: models.smart.trim(), budgetUsd: Number(models.budget) });
      }}>
        <Field label="Дешёвая модель" value={models.cheap} onChange={(cheap) => setModels((m) => ({ ...m, cheap }))} />
        <Field label="Умная модель" value={models.smart} onChange={(smart) => setModels((m) => ({ ...m, smart }))} />
        <Field label="Бюджет, $ в месяц" value={models.budget} onChange={(budget) => setModels((m) => ({ ...m, budget }))} narrow />
        <Button type="submit" disabled={busy}>Сохранить</Button>
      </form>

      <div className="space-y-1">
        <h3 className="font-medium text-gray-200">Куда идёт задача</h3>
        <p className="text-xs text-gray-500">«Улучшать» — переделать старые результаты, когда задача назначена на модель сильнее той, что их сделала.</p>
        <div className="divide-y divide-gray-700/60">
          {LLM_TASKS.map((t) => (
            <TaskRow key={t} task={t} pool={s.tasks[t]} upgrade={Boolean(s.upgrade[t])} disabled={busy}
              onPool={(pool) => void save({ tasks: { [t]: pool } as Record<LlmTask, Pool> })}
              onUpgrade={(v) => void save({ upgrade: { [t]: v } })} />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium text-gray-200">Проверка</h3>
        <div className="flex flex-wrap gap-2">
          {POOLS.map(([p, label]) => (
            <Button key={p} size="sm" onClick={() => void runTest(p)} disabled={test[p] === "…" || (p !== "local" && !st.key.set)}>
              {label}: {p === "local" ? st.ollama.model : p === "cheap" ? s.cheap : s.smart}
            </Button>
          ))}
        </div>
        {Object.entries(test).map(([p, r]) => (
          <p key={p} className="text-xs text-gray-400">
            {r === "…" ? <>Проверяю {p}…</> : r.ok
              ? <span className="text-positive-300">{r.model}: ответ за {(r.ms / 1000).toFixed(1)} с, токенов {r.usage?.prompt ?? 0} → {r.usage?.completion ?? 0}, цена {usd(r.costUsd)}</span>
              : <span className="text-negative-300">{r.model || p}: {r.error}</span>}
          </p>
        ))}
      </div>

      <UsageTable rows={usage ?? []} />

      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
          if (await confirm({ title: "Сбросить настройки ИИ?", text: "Режим, модели, бюджет и пулы задач вернутся к значениям из .env." })) {
            setBusy(true);
            try {
              qc.setQueryData(["llm"], await api<LlmStatus>("/api/llm/settings", { method: "DELETE" }));
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }
        }}>Сбросить к .env</Button>
      </div>
    </div>
  );
}

/** Пока настройки не пришли: подписи и список задач — настоящие (они постоянные), значения — плашками. */
function LlmCardSkeleton() {
  return (
    <div className="space-y-5 text-sm" aria-busy>
      <div className="flex flex-wrap gap-2">{["w-44", "w-52", "w-36"].map((w) => <Skel key={w} className={cx("h-6 rounded-full", w)} />)}</div>
      <div className="space-y-2"><Skel className="h-9 w-96 max-w-full rounded-lg" /><Skel className="h-4 w-80 max-w-full" /></div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-gray-300">Расход в этом месяце</span><Skel className="h-4 w-24" /></div>
        <Skel className="h-1.5 w-full rounded-full" />
        <p className="text-xs text-gray-500">Бюджет исчерпан — задачи до конца месяца идут локально.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {["w-44", "w-44", "w-28"].map((w, i) => <div key={i} className="space-y-1"><Skel className="h-3 w-24" /><Skel className={cx("h-9.5 rounded-md", w)} /></div>)}
        <Skel className="h-9 w-28 rounded-lg" />
      </div>
      <div className="space-y-1">
        <h3 className="font-medium text-gray-200">Куда идёт задача</h3>
        <p className="text-xs text-gray-500">«Улучшать» — переделать старые результаты, когда задача назначена на модель сильнее той, что их сделала.</p>
        <div className="divide-y divide-gray-700/60">
          {LLM_TASKS.map((t) => (
            <div key={t} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0 flex-1"><p className="text-gray-200">{TASK_LABELS[t].title}</p><p className="text-xs text-gray-500">{TASK_LABELS[t].hint}</p></div>
              <Skel className="h-9 w-64 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, narrow }: { label: string; value: string; onChange: (v: string) => void; narrow?: boolean }) {
  return (
    <label className="space-y-1">
      <span className="block text-xs text-gray-400">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className={cx("rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none", narrow ? "w-28" : "w-44")} />
    </label>
  );
}

function TaskRow({ task, pool, upgrade, disabled, onPool, onUpgrade }: {
  task: LlmTask; pool: Pool; upgrade: boolean; disabled: boolean; onPool: (p: Pool) => void; onUpgrade: (v: boolean) => void;
}) {
  const l = TASK_LABELS[task];
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-3 py-2", disabled && "opacity-70")}>
      <div className="min-w-0 flex-1">
        <p className="text-gray-200">{l.title}</p>
        <p className="text-xs text-gray-500">{l.hint}</p>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        <input type="checkbox" checked={upgrade} onChange={(e) => onUpgrade(e.target.checked)} className="accent-indigo-500" />
        улучшать
      </label>
      <Segmented value={pool} onChange={onPool} options={POOLS} />
    </div>
  );
}

function UsageTable({ rows }: { rows: LlmUsageRow[] }) {
  if (!rows.length) return <p className="text-xs text-gray-500">В этом месяце вызовов ИИ ещё не было.</p>;
  const label = (t: string) => (t in TASK_LABELS ? TASK_LABELS[t as LlmTask].title : t === "test" ? "Проверка" : t);
  return (
    <div className="space-y-1">
      <h3 className="font-medium text-gray-200">Расход за месяц</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-gray-500">
            <tr className="text-left">
              <th className="py-1 pr-3 font-normal">Задача</th><th className="pr-3 font-normal">Модель</th>
              <th className="pr-3 text-right font-normal">Вызовов</th><th className="pr-3 text-right font-normal">Токены вход → выход</th>
              <th className="text-right font-normal">Цена</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {rows.map((r) => (
              <tr key={`${r.task}|${r.provider}|${r.model}`} className="border-t border-gray-700/60">
                <td className="py-1 pr-3">{label(r.task)}</td>
                <td className="pr-3 text-gray-400">{r.provider === "ollama" ? `локально · ${r.model}` : r.model}</td>
                <td className="pr-3 text-right">{r.calls}{r.errors ? <span className="text-negative-300"> ({r.errors} ош.)</span> : null}</td>
                <td className="pr-3 text-right">{k(r.prompt)}{r.cacheHit ? ` (кэш ${k(r.cacheHit)})` : ""} → {k(r.completion)}</td>
                <td className="text-right">{r.provider === "ollama" ? "—" : usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
