import "server-only";
import sharp from "sharp";
import type { JsonSchema } from "@/lib/json-lite";
import { displayTitle } from "@/lib/schedule";
import { bestOutput, hashOf, recordOutput } from "./knowledge";
import { glossaryHint } from "./glossary";
import { getMedia } from "./lists";
import { runTask } from "./llm";
import { episodeSource } from "./playback";
import { grab } from "./plot-frames";
import type { PlaySession } from "./player";
import { ApiError } from "./route";

// «Перевести кадр» (TASKS 9.5б): на паузе — кадр серии (ffmpeg, опорный кадр у секунды), модель со зрением (только
// локально) находит надписи в кадре: текст, перевод и рамка. Рамки — в долях 0–1000 кадра (для слоя поверх видео).
// Как в plot-frames: кадр — в квадрат с полями, ответ в привычном модели виде (bbox_2d) без ограничения схемой.
// Результат — в журнал знаний от ИИ по файлу серии и секунде.

import type { FrameItem } from "@/lib/player";
type Raw = { items?: { bbox_2d?: number[]; text?: string; ru?: string }[] };

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { bbox_2d: { type: "array", items: { type: "integer", minimum: 0, maximum: 1000 } }, text: { type: "string" }, ru: { type: "string" } },
      },
    },
  },
};

const SYSTEM = "You read text in anime frames and translate it into Russian.";
const ask = (title: string, names: string[]) => `This is a frame from the anime «${title}».${names.length ? `
Names and terms of this series in Russian (use these spellings): ${names.join("; ")}.` : ""}
Find every piece of written text in the image: signs, banners, screens, notes, letters, titles, labels. Japanese text may be vertical (top to bottom columns) — list each block separately. Skip invented or decorative scripts of the fictional world that are not a real language, and TV channel logos.
Output one JSON object: {"items": [{"bbox_2d": [x1, y1, x2, y2], "text": "original text", "ru": "Russian translation"}]}.
Translate briefly, as a sign would read. If there is no text, output {"items": []}.`;

const SQ = 1024;
/** Версия подсказки — в хэше входа: ответ по старой остаётся в журнале, но текущим не считается. */
const PROMPT_V = 3;

/** Кадр в квадрат с полями: доли 0–1000 у модели совпадают с координатами квадрата. */
async function square(frame: Buffer) {
  const meta = await sharp(frame).metadata();
  const w = meta.width ?? 1920, h = meta.height ?? 1080;
  const s = SQ / Math.max(w, h);
  const rw = Math.round(w * s), rh = Math.round(h * s);
  const img = await sharp(frame).resize(rw, rh).extend({
    top: Math.floor((SQ - rh) / 2), bottom: Math.ceil((SQ - rh) / 2), left: Math.floor((SQ - rw) / 2), right: Math.ceil((SQ - rw) / 2), background: "#000",
  }).jpeg({ quality: 90 }).toBuffer();
  return { img, w, h };
}

/** Рамка в квадрате (0–1000) → доли 0–1000 исходного кадра. */
function unsquare(box: number[], w: number, h: number): [number, number, number, number] | null {
  const s = 1000 / Math.max(w, h);
  const ox = (1000 - w * s) / 2, oy = (1000 - h * s) / 2;
  const [x1, y1, x2, y2] = box.map((v, i) => (i % 2 ? (v - oy) / (h * s) : (v - ox) / (w * s)) * 1000);
  const c = (v: number) => Math.round(Math.max(0, Math.min(1000, v)));
  return x2 > x1 && y2 > y1 ? [c(x1), c(y1), c(x2), c(y2)] : null;
}

const running = new Map<string, Promise<FrameItem[]>>();

/** Надписи в кадре у секунды t (сохранённые — сразу). */
export function frameText(s: PlaySession, t: number): Promise<FrameItem[]> {
  const sec = Math.round(t * 2) / 2;
  const subject = `frame:${s.itemKey}:${sec}`;
  const inputHash = hashOf({ subject, v: PROMPT_V });
  const ready = bestOutput<{ items: FrameItem[] }>("frame", subject, { inputHash, policy: "tier-first", staleOk: false });
  if (ready?.fresh) return Promise.resolve(ready.value.items);
  const cur = running.get(subject);
  if (cur) return cur;
  const run = (async () => {
    const src = await episodeSource(s.anilistId, s.ep);
    if (!src) throw new ApiError(404, "Видео серии не найдено");
    const sq = await square(await grab(src, sec));
    const m = getMedia(s.anilistId);
    const res = await runTask<Raw>("frame", {
      schema: SCHEMA, system: SYSTEM, user: ask(m ? displayTitle(m.title) : "anime", await glossaryHint({ anime: s.anilistId }).catch(() => [])), images: [sq.img.toString("base64")],
      maxTokens: 1500, timeoutMs: 180_000, freeform: true,
    });
    const items: FrameItem[] = [];
    for (const it of res.value.items ?? []) {
      const box = it.bbox_2d?.length === 4 ? unsquare(it.bbox_2d, sq.w, sq.h) : null;
      if (box && (it.ru?.trim() || it.text?.trim())) items.push({ text: (it.text ?? "").trim(), ru: (it.ru ?? it.text ?? "").trim(), box });
    }
    recordOutput("frame", subject, res, { items }, { schemaV: 1, promptV: PROMPT_V, inputHash });
    return items;
  })().finally(() => running.delete(subject));
  running.set(subject, run);
  return run;
}
