import { PROVIDERS, providerById } from "@/server/books/library";
import { ordered, providerConfig, saveProviderConfig } from "@/server/books/provider-config";
import { sourcesHealth } from "@/server/sources";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Провайдеры глав (карточка в Настройках): список по порядку, включены ли, состояние источника; токен Lib — замаскирован.

const mask = (t: string | null) => (t ? `${t.slice(0, 4)}***` : null);

export const GET = authed(async (_req, user) => {
  adminOnly(user);
  const cfg = providerConfig();
  const health = new Map(sourcesHealth().map((h) => [h.id, h]));
  return json({
    providers: ordered(PROVIDERS, cfg).map((p) => {
      const h = health.get(p.source);
      return {
        id: p.id, name: p.name, kinds: p.kinds, langs: p.langs, enabled: !cfg.disabled.includes(p.id),
        down: h?.down ?? false, lastError: h?.lastError ?? null, lastOk: h?.lastOk ?? null,
      };
    }),
    libToken: mask(cfg.libToken),
  });
});

/** { order?, disabled?, libToken? (пустая строка — убрать) } */
export const PUT = authed(async (req, user) => {
  adminOnly(user);
  const b = (await req.json().catch(() => ({}))) as { order?: string[]; disabled?: string[]; libToken?: string | null };
  const known = (ids?: string[]) => ids?.filter((id) => providerById(id));
  saveProviderConfig({
    ...(b.order ? { order: known(b.order) } : {}),
    ...(b.disabled ? { disabled: known(b.disabled) } : {}),
    ...(b.libToken !== undefined ? { libToken: b.libToken?.trim().replace(/^Bearer\s+/i, "") || null } : {}),
  });
  return json({ ok: true });
});

/** Проверка связи: { id } → { ok, ms, error? } */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  const p = id ? providerById(id) : undefined;
  if (!p) throw new ApiError(404, "Нет такого провайдера");
  const t = Date.now();
  try {
    await p.ping();
    return json({ ok: true, ms: Date.now() - t });
  } catch (e) {
    return json({ ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) });
  }
});
