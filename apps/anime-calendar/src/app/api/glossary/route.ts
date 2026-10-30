import { TERM_KINDS, type TermKind } from "@/lib/glossary";
import { addTerm, collectGlossary, editTerm, glossaryMeta, glossaryRoot, loadTerms, type GlossaryRef, type TermPatch } from "@/server/glossary";
import { adminOnly, ApiError, authed, json } from "@/server/route";

// Единый глоссарий франшизы: ?anime=<id> или ?book=<id> → корень. Смотреть — всем, править и собирать — админу.

function refOf(req: Request): GlossaryRef {
  const q = new URL(req.url).searchParams;
  const anime = Number(q.get("anime")), book = Number(q.get("book"));
  if (anime > 0) return { anime };
  if (book > 0) return { book };
  throw new ApiError(400, "Нужен anime или book");
}

const cleanKind = (k: unknown): TermKind => (typeof k === "string" && k in TERM_KINDS ? (k as TermKind) : "name");
const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);

export const GET = authed(async (req) => {
  const root = await glossaryRoot(refOf(req));
  return json({ ...glossaryMeta(root), terms: loadTerms(root) });
});

/** { collect: true } — собрать из источников; { term } — добавить вручную. */
export const POST = authed(async (req, user) => {
  adminOnly(user);
  const root = await glossaryRoot(refOf(req));
  const b = (await req.json().catch(() => ({}))) as { collect?: boolean; term?: Record<string, unknown> };
  if (b.collect) {
    void collectGlossary(root).catch((e) => console.warn(`[glossary] ${root}: ${String(e)}`));
    return json(glossaryMeta(root));
  }
  const t = b.term ?? {};
  try {
    addTerm(root, { kind: cleanKind(t.kind), ja: str(t.ja), en: str(t.en), ru: str(t.ru) ?? "", alts: Array.isArray(t.alts) ? t.alts.map(String).filter(Boolean) : [], note: str(t.note) });
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : String(e));
  }
  return json({ ok: true });
});

/** { id, patch } — ручная правка (закрепляет), { id, patch: { hidden } } — убрать или вернуть. */
export const PUT = authed(async (req, user) => {
  adminOnly(user);
  const root = await glossaryRoot(refOf(req));
  const b = (await req.json().catch(() => ({}))) as { id?: number; patch?: Record<string, unknown> };
  const p = b.patch ?? {};
  const patch: TermPatch = {};
  if (p.kind !== undefined) patch.kind = cleanKind(p.kind);
  for (const k of ["ja", "en", "note"] as const) if (p[k] !== undefined) patch[k] = str(p[k]);
  if (p.ru !== undefined) {
    const ru = str(p.ru);
    if (!ru) throw new ApiError(400, "Русское написание не может быть пустым");
    patch.ru = ru;
  }
  if (Array.isArray(p.alts)) patch.alts = p.alts.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof p.locked === "boolean") patch.locked = p.locked;
  if (typeof p.hidden === "boolean") patch.hidden = p.hidden;
  if (!b.id || !editTerm(root, b.id, patch)) throw new ApiError(404, "Нет такого термина");
  return json({ ok: true });
});
