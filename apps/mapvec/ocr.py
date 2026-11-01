"""Подписи карты через dots.mocr: карта режется на куски с перекрытием (мелкий текст), строки — с рамками,
строки одной надписи склеиваются. Модель грузится при первом запросе и выгружается после простоя (видеокарту
делит ещё и Ollama)."""
import json
import os
import re
import threading
import time

import torch
from PIL import Image

MODELS = os.environ.get("MAPVEC_MODELS", "/models")
REPO = "rednote-hilab/dots.mocr"
LOCAL = os.path.join(MODELS, "DotsMOCR")  # без точки в имени: иначе модуль модели не импортируется
IDLE_S = int(os.environ.get("MAPVEC_IDLE_S", "600"))
TILE, OVER = 640, 160
PROMPT = "Detect and recognize the text in the image."
QUAD = re.compile(r"\((\d+), (\d+)\), \((\d+), (\d+)\), \((\d+), (\d+)\), \((\d+), (\d+)\)([^(]*)")

_model = _proc = None
_used = 0.0
_lock = threading.Lock()
device = "cuda" if torch.cuda.is_available() else "cpu"


def _fetch():
    """Веса с Hugging Face (один раз) и правка под окружение без flash-attn: внимание SDPA из PyTorch."""
    if not os.path.exists(os.path.join(LOCAL, "model.safetensors.index.json")):
        from huggingface_hub import snapshot_download
        snapshot_download(REPO, local_dir=LOCAL, allow_patterns=["*.json", "*.py", "*.txt", "*.safetensors"])
    vision = os.path.join(LOCAL, "modeling_dots_vision.py")
    src = open(vision, encoding="utf-8").read()
    if "except ImportError" not in src:
        src = src.replace("from flash_attn import flash_attn_varlen_func",
                          "try:\n    from flash_attn import flash_attn_varlen_func\nexcept ImportError:\n    flash_attn_varlen_func = None")
        open(vision, "w", encoding="utf-8").write(src)
    cfg_path = os.path.join(LOCAL, "config.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    if cfg.get("vision_config", {}).get("attn_implementation") != "sdpa":
        cfg.setdefault("vision_config", {})["attn_implementation"] = "sdpa"
        json.dump(cfg, open(cfg_path, "w", encoding="utf-8"), indent=2)


def _load():
    global _model, _proc
    if _model is None:
        from transformers import AutoModelForCausalLM, AutoProcessor
        _fetch()
        _model = AutoModelForCausalLM.from_pretrained(LOCAL, attn_implementation="sdpa", trust_remote_code=True, device_map=device,
                                                      dtype=torch.bfloat16 if device == "cuda" else torch.float32)
        _proc = AutoProcessor.from_pretrained(LOCAL, trust_remote_code=True)
    return _model, _proc


def unload_idle():
    """Выгрузить модель после простоя — освободить видеопамять."""
    global _model, _proc
    while True:
        time.sleep(30)
        with _lock:
            if _model is not None and time.time() - _used > IDLE_S:
                _model = _proc = None
                if device == "cuda":
                    torch.cuda.empty_cache()
                print("[mapvec] dots.mocr выгружена после простоя", flush=True)


def loaded() -> bool:
    return _model is not None


def _spot(model, proc, tile):
    msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT}]}]
    text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    inp = proc(text=[text], images=[tile], return_tensors="pt").to(device)
    ids = model.generate(**inp, max_new_tokens=3000, do_sample=False)
    res = proc.decode(ids[0][inp.input_ids.shape[1]:], skip_special_tokens=True)
    for m in QUAD.finditer(res):
        xs, ys = [int(v) for v in m.groups()[0:8:2]], [int(v) for v in m.groups()[1:8:2]]
        t = m.group(9).strip()
        if t:
            yield t, min(xs), min(ys), max(xs), max(ys)


def _starts(n):
    s = list(range(0, max(1, n - TILE) + 1, TILE - OVER))
    return s if s[-1] + TILE >= n else s + [n - TILE]


def _iou_min(p, q):
    """Пересечение к меньшей рамке: повтор строки из соседнего куска."""
    ix = max(0, min(p["x1"], q["x1"]) - max(p["x0"], q["x0"]))
    iy = max(0, min(p["y1"], q["y1"]) - max(p["y0"], q["y0"]))
    area = lambda r: (r["x1"] - r["x0"]) * (r["y1"] - r["y0"])
    return ix * iy / max(1, min(area(p), area(q)))


def merge_lines(lines):
    """Строки одной надписи: друг под другом (можно чуть внахлёст), по центру, близкой высоты
    (у строки без выносных букв рамка ниже: «Kingdom of» 19 px над «Brumund» 14 px)."""
    lines = sorted(lines, key=lambda l: l["y0"])
    groups = []
    for l in lines:
        h = l["y1"] - l["y0"]
        for g in groups:
            last = g[-1]
            cx, gx = (l["x0"] + l["x1"]) / 2, (last["x0"] + last["x1"]) / 2
            wmax = max(l["x1"] - l["x0"], last["x1"] - last["x0"])
            hmax = max(h, last["y1"] - last["y0"])
            if -h * 0.4 <= l["y0"] - last["y1"] < h * 0.6 and abs(cx - gx) < wmax * 0.3 and abs(h - (last["y1"] - last["y0"])) < hmax * 0.45:
                g.append(l)
                break
        else:
            groups.append([l])
    out = []
    for g in groups:
        out.append(dict(text=" ".join(l["text"] for l in g),
                        x0=min(l["x0"] for l in g), y0=min(l["y0"] for l in g), x1=max(l["x1"] for l in g), y1=max(l["y1"] for l in g),
                        lines=[[l["x0"], l["y0"], l["x1"], l["y1"], l["text"]] for l in g]))
    return out


def read_labels(img: Image.Image, progress=None):
    """Подписи карты в пикселях: [{text, x0, y0, x1, y1, lines: [[x0, y0, x1, y1, text]]}]."""
    global _used
    W, H = img.size
    with _lock:
        model, proc = _load()
        lines = []
        cells = [(x0, y0) for y0 in _starts(H) for x0 in _starts(W)]
        for i, (x0, y0) in enumerate(cells):
            tw, th = min(TILE, W - x0), min(TILE, H - y0)
            for t, a, b, c, d in _spot(model, proc, img.crop((x0, y0, x0 + tw, y0 + th))):
                # Строка, обрезанная краем куска, — её целиком прочтёт соседний кусок (рамку видимой части модель
                # ставит на несколько пикселей раньше края)
                m = 12
                cut = (a < m and x0 > 0) or (b < m and y0 > 0) or (c > tw - m and x0 + tw < W) or (d > th - m and y0 + th < H)
                lines.append(dict(text=t, x0=x0 + a, y0=y0 + b, x1=x0 + c, y1=y0 + d, cut=cut))
            if progress:
                progress(i + 1, len(cells))
        # Повторы из перекрытий: целая строка важнее обрезанной, длинная — короткой
        lines.sort(key=lambda l: (l["cut"], -len(l["text"])))
        uniq = []
        for l in lines:
            if not any(_iou_min(l, u) > 0.5 for u in uniq):
                uniq.append(l)
        # Мусор (рисунки, прочитанные как один-два знака) и обрезанные обрывки
        uniq = [l for l in uniq if len(re.sub(r"[^\w]", "", l["text"])) > 2 and (not l["cut"] or len(l["text"]) > 3)]
        labels = merge_lines(uniq)
        _reread(model, proc, img, labels)
        _used = time.time()
    for l in labels:
        for ln in l["lines"]:
            # Слипшееся «Kingdomof» — модель теряет узкий пробел
            ln[4] = re.sub(r"([a-z]{3,})of\b", r"\1 of", ln[4])
        l["text"] = " ".join(ln[4] for ln in l["lines"])
    return labels


def _iou(p, q):
    ix = max(0, min(p[2], q[2]) - max(p[0], q[0]))
    iy = max(0, min(p[3], q[3]) - max(p[1], q[1]))
    union = (p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - ix * iy
    return ix * iy / max(1, union)


def _reread(model, proc, img, labels):
    """Второе чтение: каждая подпись — в своём куске, по центру. Край куска сетки режет буквы («Land of Puppe»),
    здесь подпись целиком и с запасом; текст строки берём отсюда, если рамки совпали."""
    W, H = img.size
    for l in labels:
        w, h = l["x1"] - l["x0"], l["y1"] - l["y0"]
        px, py = max(80, w // 2), max(60, h * 2)
        x0, y0 = max(0, l["x0"] - px), max(0, l["y0"] - py)
        x1, y1 = min(W, l["x1"] + px), min(H, l["y1"] + py)
        found = [(t, (x0 + a, y0 + b, x0 + c, y0 + d)) for t, a, b, c, d in _spot(model, proc, img.crop((x0, y0, x1, y1)))]
        for ln in l["lines"]:
            best = max(found, key=lambda f: _iou(ln, f[1]), default=None)
            if best and _iou(ln, best[1]) > 0.5 and len(re.sub(r"[^\w]", "", best[0])) > 2:
                ln[:] = [*best[1], best[0]]
        # Рамка подписи — по уточнённым строкам
        l["x0"], l["y0"] = min(ln[0] for ln in l["lines"]), min(ln[1] for ln in l["lines"])
        l["x1"], l["y1"] = max(ln[2] for ln in l["lines"]), max(ln[3] for ln in l["lines"])


PAGE_MAX = int(os.environ.get("MAPVEC_PAGE_MAX", "1600"))


def read_lines(img: Image.Image):
    """Строки текста страницы манги за один проход (страница целиком, длинная сторона — не больше PAGE_MAX):
    [{text, x0, y0, x1, y1}] в пикселях исходной картинки. Склейка строк в пузыри — у календаря."""
    global _used
    W, H = img.size
    k = min(1.0, PAGE_MAX / max(W, H))
    small = img.resize((round(W * k), round(H * k))) if k < 1 else img
    with _lock:
        model, proc = _load()
        lines = [dict(text=t, x0=round(a / k), y0=round(b / k), x1=round(c / k), y1=round(d / k))
                 for t, a, b, c, d in _spot(model, proc, small)]
        _used = time.time()
    return lines


# Текст страницы целиком (без рамок) — промпт на языке текста: английский промпт поиска текста читает заглавную
# кириллицу манги латиницей-двойником («ПОХОЖЕ» → «NOXOKE»), русский — кириллицей
TEXT_PROMPTS = {
    "ru": "Найди и распознай русский текст на изображении.",
    "en": "Detect and recognize the text in the image.",
    "ja": "画像内の日本語のテキストを検出して認識してください。",
}


def read_text(img: Image.Image, lang: str = "ru") -> str:
    """Весь текст страницы по порядку чтения (для пересказа главы); длинная сторона — не больше PAGE_MAX."""
    global _used
    W, H = img.size
    k = min(1.0, PAGE_MAX / max(W, H))
    small = img.resize((round(W * k), round(H * k))) if k < 1 else img
    prompt = TEXT_PROMPTS.get(lang, TEXT_PROMPTS["en"])
    with _lock:
        model, proc = _load()
        msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
        text = proc.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inp = proc(text=[text], images=[small], return_tensors="pt").to(device)
        ids = model.generate(**inp, max_new_tokens=1500, do_sample=False, repetition_penalty=1.05)
        res = proc.decode(ids[0][inp.input_ids.shape[1]:], skip_special_tokens=True)
        _used = time.time()
    # Режим поиска текста отдаёт рамки «(x, y), …» перед строками — оставляем только текст
    lines = [m.group(9).strip() for m in QUAD.finditer(res)] if QUAD.search(res) else res.splitlines()
    return "\n".join(l for l in (x.strip() for x in lines) if l and not re.fullmatch(r"(.)\1{8,}", l))
