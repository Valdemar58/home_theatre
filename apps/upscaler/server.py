"""HTTP-обёртка над realesrgan-ncnn-vulkan.

GET  /health                         — {"ok": true, "device": "...", "models": [...]}
POST /upscale?model=...&scale=N      — тело: картинка (jpg/png/webp) → PNG; заголовок X-Elapsed-Ms

Модели (идут в архиве Real-ESRGAN):
  realesr-animevideov3   — аниме, быстрая, масштаб 2/3/4 (свои веса под каждый)
  realesrgan-x4plus-anime — аниме-иллюстрации, качественнее и медленнее, только ×4
Один запрос за раз: GPU делит с ним ещё и LLM.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BIN = "/opt/realesrgan/realesrgan-ncnn-vulkan"
MODELS = {"realesr-animevideov3": (2, 3, 4), "realesrgan-x4plus-anime": (4,), "realesrgan-x4plus": (4,)}
MAX_BYTES = 20 * 1024 * 1024
lock = threading.Lock()
device = "unknown"


def run(src: bytes, model: str, scale: int, tile: int) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        inp, out = os.path.join(d, "in"), os.path.join(d, "out.png")
        with open(inp, "wb") as f:
            f.write(src)
        cmd = [BIN, "-i", inp, "-o", out, "-n", model, "-s", str(scale), "-t", str(tile), "-f", "png",
               "-m", "/opt/realesrgan/models"]
        p = subprocess.run(cmd, capture_output=True, timeout=300)
        if p.returncode != 0 or not os.path.exists(out):
            raise RuntimeError((p.stderr or p.stdout).decode(errors="replace")[-600:])
        with open(out, "rb") as f:
            return f.read()


def tiny_png(w: int, h: int) -> bytes:
    """Серая картинка w×h в PNG (для проверки устройства при старте)."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x80\x80\x80" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def detect_device() -> str:
    """Какое устройство увидит ncnn: строка «[0 NVIDIA GeForce …]» из вывода."""
    png = tiny_png(8, 8)
    with tempfile.TemporaryDirectory() as d:
        inp, out = os.path.join(d, "in.png"), os.path.join(d, "out.png")
        open(inp, "wb").write(png)
        p = subprocess.run([BIN, "-i", inp, "-o", out, "-n", "realesr-animevideov3", "-s", "2", "-m", "/opt/realesrgan/models"],
                           capture_output=True, timeout=120)
        text = (p.stderr + p.stdout).decode(errors="replace")
        for line in text.splitlines():
            if line.startswith("[0 "):
                return line.split("]")[0].strip("[").split(" ", 1)[1]
        return "ошибка: " + text[-300:] if p.returncode else "?"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # без шума в логах на каждый запрос
        pass

    def send(self, code: int, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self.send(404, b'{"error":"not found"}')
        ok = not device.startswith("ошибка")
        self.send(200 if ok else 503, json.dumps({"ok": ok, "device": device, "models": {k: list(v) for k, v in MODELS.items()}}).encode())

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/upscale":
            return self.send(404, b'{"error":"not found"}')
        q = parse_qs(u.query)
        model = q.get("model", ["realesr-animevideov3"])[0]
        scale = int(q.get("scale", ["2"])[0])
        tile = int(q.get("tile", ["0"])[0])
        if model not in MODELS or scale not in MODELS[model]:
            return self.send(400, json.dumps({"error": f"модель {model} не умеет ×{scale}"}).encode())
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BYTES:
            return self.send(400, b'{"error":"bad body"}')
        src = self.rfile.read(n)
        with lock:
            t = time.time()
            try:
                out = run(src, model, scale, tile)
            except Exception as e:  # noqa: BLE001
                return self.send(500, json.dumps({"error": str(e)}).encode())
            ms = int((time.time() - t) * 1000)
        self.send(200, out, "image/png", {"X-Elapsed-Ms": str(ms), "X-Device": device.encode("ascii", "replace").decode()})


if __name__ == "__main__":
    device = detect_device()
    print(f"[upscaler] устройство: {device}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
