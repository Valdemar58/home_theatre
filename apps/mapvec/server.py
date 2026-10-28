"""HTTP-обёртка векторизации карт.

GET  /health      — {"ok": true, "device": "cuda|cpu", "ocr_loaded": bool}
POST /ocr         — тело: картинка карты → {"width", "height", "labels": [{text, x0, y0, x1, y1, lines}]} (пиксели)
POST /vectorize   — тело: JSON {"image": base64, "labels": [...] из /ocr} → {"width", "height", "land", "regions"}
Запросы по одному: модель на видеокарте одна.
"""
import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import cv2
import numpy as np
from PIL import Image

import ocr
import vector

MAX_BYTES = 60 * 1024 * 1024
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # без шума в логах на каждый запрос
        pass

    def send(self, code: int, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            return self.send(404, {"error": "not found"})
        self.send(200, {"ok": True, "device": ocr.device, "ocr_loaded": ocr.loaded()})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BYTES:
            return self.send(400, {"error": "bad body"})
        body = self.rfile.read(n)
        t = time.time()
        try:
            with lock:
                if self.path == "/ocr":
                    img = Image.open(BytesIO(body)).convert("RGB")
                    out = dict(width=img.width, height=img.height, labels=ocr.read_labels(img))
                elif self.path == "/vectorize":
                    req = json.loads(body)
                    img = cv2.imdecode(np.frombuffer(base64.b64decode(req["image"]), np.uint8), cv2.IMREAD_COLOR)
                    out = vector.vectorize(img, req["labels"])
                else:
                    return self.send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})
        out["ms"] = int((time.time() - t) * 1000)
        print(f"[mapvec] {self.path} за {out['ms'] / 1000:.1f} с", flush=True)
        self.send(200, out)


if __name__ == "__main__":
    threading.Thread(target=ocr.unload_idle, daemon=True).start()
    print(f"[mapvec] устройство: {ocr.device}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
