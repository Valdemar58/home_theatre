// Метки говорящих в японских субтитрах («（三上）…») → персонажи графа. Сначала без модели: толпа отсекается правилами,
// метка, совпавшая с японским именем, сопоставляется строкой; модели остаются только спорные метки. Любой ответ
// проверяется фактами: метка не может принадлежать персонажу, если звучит раньше его первого появления.

/** Метка толпы или безымянного: «部下», «オークたち», «エルフＡ», «男», «村人2». Такие — не персонажи. */
export function isCrowdLabel(label: string): boolean {
  const l = label.trim();
  if (/(たち|達|ども|ら|一同|全員)$/.test(l)) return true;
  if (/[ＡＢＣＤＥＦA-F１-９1-9]$/.test(l)) return true;
  return /^(部下|兵士|兵|男|女|少女|少年|子供|村人|群衆|通行人|人々|店員|客|声|一同|全員|冒険者|ゴブリン|オーク|エルフ|オーガ|リザードマン|ドワーフ|魔物|騎士|衛兵|門番|住人|職員|生徒|学生|先生|老人|老婆|母親|父親)$/.test(l);
}

const normJa = (s: string) => s.normalize("NFKC").replace(/[・＝=\s　]/g, "").replace(/ー/g, "ー");

export type SpeakerPerson = { id: number; names: string[]; firstEp: number };

/**
 * Метка → персонаж по японскому имени: точное совпадение или вхождение (метка — часть имени: «ガゼル» в «ガゼル・ドワルゴ»,
 * или имя — часть метки). Однозначно — id, несколько кандидатов — их список, ни одного — пусто.
 */
export function matchByName(label: string, people: SpeakerPerson[]): number[] {
  const l = normJa(label);
  if (l.length < 2) return [];
  const exact = people.filter((p) => p.names.some((n) => normJa(n) === l));
  if (exact.length) return [...new Set(exact.map((p) => p.id))];
  const part = people.filter((p) => p.names.some((n) => { const x = normJa(n); return x.length >= 2 && (x.includes(l) || l.includes(x)); }));
  return [...new Set(part.map((p) => p.id))];
}

/** Метка звучит не раньше первого появления персонажа (по сериям этого тайтла). */
export const consistent = (labelFirstEp: number, person: SpeakerPerson) => person.firstEp <= labelFirstEp;
