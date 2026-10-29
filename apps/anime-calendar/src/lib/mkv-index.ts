// Индекс MKV (Cues): какой байт файла — какая секунда. Для полоски «скачано TorrServer» в плеере: пропорция по размеру
// врёт на десятки секунд (битрейт BD-рипа с FLAC сильно скачет), а Cues дают точные пары «время — позиция кластера».
// Разбор EBML без зависимостей: заголовок (SeekHead → где Cues, Info → единица времени) и сам Cues.

const ID = { segment: 0x18538067, seekHead: 0x114d9b74, seek: 0x4dbb, seekId: 0x53ab, seekPos: 0x53ac, info: 0x1549a966, timecodeScale: 0x2ad7b1, cues: 0x1c53bb6b, cuePoint: 0xbb, cueTime: 0xb3, cueTrackPositions: 0xb7, cueClusterPosition: 0xf1 };

type El = { id: number; data: number; end: number };

/** Номер элемента (с маркером длины) и размер (без маркера) с позиции i. */
function readEl(b: Uint8Array, i: number): El | null {
  const vint = (at: number, keepMarker: boolean) => {
    const first = b[at];
    if (first === undefined || first === 0) return null;
    let len = 1;
    while (!(first & (0x80 >> (len - 1)))) len++;
    if (at + len > b.length) return null;
    let v = keepMarker ? first : first & (0xff >> len);
    let allOnes = v === (0xff >> len);
    for (let k = 1; k < len; k++) { v = v * 256 + b[at + k]; if (b[at + k] !== 0xff) allOnes = false; }
    return { v, len, unknown: !keepMarker && allOnes };
  };
  const id = vint(i, true);
  if (!id) return null;
  const size = vint(i + id.len, false);
  if (!size) return null;
  const data = i + id.len + size.len;
  return { id: id.v, data, end: size.unknown ? Infinity : data + size.v };
}

function children(b: Uint8Array, start: number, end: number): El[] {
  const out: El[] = [];
  for (let i = start; i < Math.min(end, b.length);) {
    const el = readEl(b, i);
    if (!el) break;
    out.push(el);
    if (!Number.isFinite(el.end)) break;
    i = el.end;
  }
  return out;
}

const uint = (b: Uint8Array, el: El) => {
  let v = 0;
  for (let k = el.data; k < Math.min(el.end, b.length); k++) v = v * 256 + b[k];
  return v;
};

/** Начало файла: где данные сегмента, где Cues (абсолютный байт, по SeekHead; нет — null) и единица времени (нс). */
export function mkvHead(head: Uint8Array): { segment: number; cues: number | null; timecodeScale: number } | null {
  const top = children(head, 0, head.length);
  const seg = top.find((e) => e.id === ID.segment);
  if (!seg) return null;
  let cues: number | null = null;
  let timecodeScale = 1_000_000;
  for (const el of children(head, seg.data, seg.end)) {
    if (el.id === ID.seekHead) {
      for (const s of children(head, el.data, el.end).filter((x) => x.id === ID.seek)) {
        const kids = children(head, s.data, s.end);
        const idEl = kids.find((x) => x.id === ID.seekId);
        const posEl = kids.find((x) => x.id === ID.seekPos);
        if (idEl && posEl && uint(head, idEl) === ID.cues) cues = seg.data + uint(head, posEl);
      }
    } else if (el.id === ID.info) {
      const ts = children(head, el.data, el.end).find((x) => x.id === ID.timecodeScale);
      if (ts) timecodeScale = uint(head, ts);
    }
    if (!Number.isFinite(el.end) || el.end > head.length) break;
  }
  return { segment: seg.data, cues, timecodeScale };
}

/** Элемент Cues целиком (buf начинается с его заголовка) → точки «секунда — абсолютный байт кластера». */
export function mkvCues(buf: Uint8Array, segment: number, timecodeScale: number): { t: number; pos: number }[] {
  const root = readEl(buf, 0);
  if (!root || root.id !== ID.cues) return [];
  const out: { t: number; pos: number }[] = [];
  for (const cp of children(buf, root.data, root.end)) {
    if (cp.id !== ID.cuePoint) continue;
    const kids = children(buf, cp.data, cp.end);
    const time = kids.find((x) => x.id === ID.cueTime);
    const tp = kids.find((x) => x.id === ID.cueTrackPositions);
    const pos = tp && children(buf, tp.data, tp.end).find((x) => x.id === ID.cueClusterPosition);
    if (time && pos) out.push({ t: (uint(buf, time) * timecodeScale) / 1e9, pos: segment + uint(buf, pos) });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** Размер заголовка элемента в начале buf (чтобы дочитать Cues целиком). */
export function elementSize(buf: Uint8Array): number | null {
  const el = readEl(buf, 0);
  return el && Number.isFinite(el.end) ? el.end : null;
}

/** Байт файла → секунда: между соседними точками Cues — линейно, за краями — до начала и конца серии. */
export function byteToTime(points: { t: number; pos: number }[], fileSize: number, duration: number) {
  const pts = [{ t: 0, pos: 0 }, ...points, { t: duration, pos: fileSize }];
  return (byte: number) => {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].pos <= byte) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi];
    return b.pos === a.pos ? a.t : a.t + ((byte - a.pos) / (b.pos - a.pos)) * (b.t - a.t);
  };
}
