"use client";
import { CameraIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { Avatar, bumpAvatar } from "./Avatar";
import { useAlert, useConfirm } from "./Dialogs";
import { Button, Modal } from "./ui";

// Смена аватарки: выбрать файл → кадрировать в круг (масштаб, перетаскивание) → 512×512 JPEG в Jellyfin.

const OUT = 512;
const VIEW = 280;

export function AvatarEditor({ user, className = "h-20 w-20 text-3xl" }: { user: { id: number; name: string }; className?: string }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const alert = useAlert();
  const confirm = useConfirm();

  // Минимальный масштаб — картинка закрывает круг целиком
  const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(VIEW - w, p.x)),
    y: Math.min(0, Math.max(VIEW - h, p.y)),
  });
  useEffect(() => { if (img) setPos((p) => clamp(p)); }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return alert({ title: "Это не картинка", text: "Выберите файл JPEG, PNG или WebP." });
    const url = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => {
      const b = VIEW / Math.min(i.naturalWidth, i.naturalHeight);
      setImg(i);
      setZoom(1);
      setPos({ x: (VIEW - i.naturalWidth * b) / 2, y: (VIEW - i.naturalHeight * b) / 2 });
    };
    i.src = url;
  };

  const save = async () => {
    if (!img) return;
    setBusy(true);
    try {
      const c = document.createElement("canvas");
      c.width = c.height = OUT;
      const k = OUT / VIEW;
      c.getContext("2d")!.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
      const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.9));
      await fetch("/api/me/avatar", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob }).then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      });
      bumpAvatar(user.id);
      setImg(null);
    } catch (e) {
      alert({ title: "Не удалось сохранить аватарку", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Убрать аватарку?", text: "Вместо неё будет первая буква имени.", confirm: "Убрать", danger: true }))) return;
    await api("/api/me/avatar", { method: "DELETE" });
    bumpAvatar(user.id);
  };

  return (
    <>
      <span className="group relative block h-full w-full shrink-0">
        <button onClick={() => file.current?.click()} title="Сменить аватарку" className="relative block h-full w-full rounded-full">
          <Avatar user={user} className={className} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 opacity-0 transition group-hover:opacity-100">
            <CameraIcon className="h-7 w-7 text-white" />
          </span>
        </button>
        <button onClick={remove} title="Убрать аватарку"
          className="absolute -right-1 -top-1 rounded-full bg-gray-800 p-1 text-gray-400 opacity-0 ring-1 ring-gray-600 transition hover:text-white group-hover:opacity-100">
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </span>
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden"
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />

      <Modal open={Boolean(img)} onClose={() => setImg(null)} title="Аватарка">
        {img && (
          <div className="space-y-4">
            <div className="mx-auto cursor-grab touch-none overflow-hidden rounded-full ring-2 ring-gray-600 active:cursor-grabbing"
              style={{ width: VIEW, height: VIEW, position: "relative" }}
              onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
              onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
              onPointerUp={() => { drag.current = null; }}
              onWheel={(e) => setZoom((z) => Math.min(4, Math.max(1, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.src} alt="" draggable={false} style={{ position: "absolute", left: pos.x, top: pos.y, width: w, height: h, maxWidth: "none" }} />
            </div>
            <label className="flex items-center gap-3 text-sm text-gray-400">
              Масштаб
              <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1 accent-accent-500" />
            </label>
            <p className="text-xs text-gray-500">Перетащите картинку, колесо — масштаб. Аватарка сохранится в Jellyfin и будет одинаковой во всех сервисах.</p>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => file.current?.click()}>Другой файл</Button>
              <Button variant="primary" disabled={busy} onClick={save}>{busy ? "Сохраняю…" : "Сохранить"}</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
