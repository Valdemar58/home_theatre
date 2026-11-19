"""Карта → суша и страны контурами.

Суша — маски SAM 2 по точкам у подписей стран (море — отрицательные точки, найдены сеткой). Страны — ячейки суши
между пунктирными границами (тонкие светлые линии), буквы подписей из границ вырезаны по рамкам строк OCR.
Ячейки растут от подписей водоразделом по удалённости от границ: в щели пунктира граница проходит в самом узком
месте. Подпись без своей границы (название поверх чужой территории) сливается с соседом.
"""
import os
import threading

import cv2
import numpy as np
from skimage.segmentation import watershed

MODELS = os.environ.get("MAPVEC_MODELS", "/models")
# Подписи не стран: у них нет своей территории с границей
NOT_COUNTRY = ("river", "lake", "mountain", "peak", "cave", "plains", "sea", "ocean", "bay", "strait", "volcano", "island")
_pred = None
_lock = threading.Lock()


def _predictor():
    global _pred
    if _pred is None:
        from ultralytics.models.sam import SAM2Predictor
        os.makedirs(MODELS, exist_ok=True)
        os.chdir(MODELS)  # веса SAM качаются в рабочую папку — пусть лежат в томе
        _pred = SAM2Predictor(overrides=dict(model="sam2.1_b.pt", verbose=False, imgsz=1024, conf=0.01, save=False))
    return _pred


def _masks(pred, W, H, pos, neg=()):
    r = pred(points=[[list(p) for p in pos] + [list(p) for p in neg]], labels=[[1] * len(pos) + [0] * len(neg)])
    return [m.cpu().numpy().astype(np.uint8) for m in (r[0].masks.data if r[0].masks is not None else [])]


def _sea(pred, W, H, seed_pts):
    """Море: крупные маски по сетке точек, в которых нет ни одной подписи страны."""
    sea = np.zeros((H, W), np.uint8)
    grid = [(int(W * fx), int(H * fy)) for fy in np.linspace(0.08, 0.92, 7) for fx in np.linspace(0.08, 0.92, 7)]
    for p in grid:
        if sea[p[1], p[0]]:
            continue
        for m in _masks(pred, W, H, [p]):
            if m.mean() > 0.06 and not any(m[y, x] for x, y in seed_pts):
                sea |= m
    neg = [p for p in grid if sea[p[1], p[0]]]
    # Не больше десятка отрицательных точек, по всей карте
    return sea, neg[:: max(1, len(neg) // 10)]


def _contours(mask, eps=2.5, min_area=300):
    cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [cv2.approxPolyDP(c, eps, True).reshape(-1, 2).tolist() for c in cs if cv2.contourArea(c) > min_area]


def vectorize(img_bgr, labels):
    """labels: [{text, x0, y0, x1, y1, lines}] в пикселях. → {land: [полигон], regions: [{label, alias, polys}]}"""
    H, W = img_bgr.shape[:2]
    seeds = [i for i, l in enumerate(labels) if not any(k in l["text"].lower() for k in NOT_COUNTRY) and len(l["text"]) >= 6]
    center = lambda l: (int((l["x0"] + l["x1"]) / 2), int((l["y0"] + l["y1"]) / 2))
    with _lock:
        pred = _predictor()
        pred.set_image(img_bgr)
        sea, neg = _sea(pred, W, H, [center(labels[i]) for i in seeds])
        land = np.zeros((H, W), np.uint8)
        for i in seeds:
            l = labels[i]
            # Точка чуть ниже подписи — на высоту строки (на самой надписи модель выделит буквы)
            lh = l["lines"][0][3] - l["lines"][0][1]
            p = (int((l["x0"] + l["x1"]) / 2), min(H - 1, int(l["y1"] + lh * 0.8)))
            for m in _masks(pred, W, H, [p], neg):
                # Маска на полкарты или с точкой моря — это море или вся бумага, а не суша
                if 0.002 < m.mean() < 0.45 and not any(m[y, x] for x, y in neg):
                    land |= m
    land[sea > 0] = 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    land = cv2.morphologyEx(cv2.morphologyEx(land, cv2.MORPH_CLOSE, k), cv2.MORPH_OPEN, k)

    # Куски суши без подписи у края или в углу (рамка, роза ветров) и «лучистые» — украшения
    n, comp, stats, _ = cv2.connectedComponentsWithStats(land)
    keep = {comp[y, x] for x, y in (center(labels[i]) for i in seeds) if comp[y, x]}
    for c in range(1, n):
        if c in keep:
            continue
        x, y, w, h, area = stats[c]
        mx, my = W * 0.06, H * 0.06
        edge = x <= mx or y <= my or x + w >= W - mx or y + h >= H - my
        corner = (x + w / 2 < W * 0.15 or x + w / 2 > W * 0.85) and (y + h / 2 < H * 0.15 or y + h / 2 > H * 0.85)
        cs, _ = cv2.findContours((comp == c).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hull = cv2.contourArea(cv2.convexHull(cs[0])) if cs else 1
        if edge or corner or area / max(hull, 1) < 0.7 or area < 400:
            land[comp == c] = 0

    # Пунктирные границы: тонкие светлые линии на суше (белый цилиндр); буквы подписей — не границы
    lum = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    top = cv2.morphologyEx(lum, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    white = ((top > 45) & (lum > 150) & (cv2.erode(land, k) > 0)).astype(np.uint8)
    for l in labels:
        for x0, y0, x1, y1, _ in l["lines"]:
            white[max(0, y0 - 2):y1 + 2, max(0, x0 - 2):x1 + 2] = 0
    wall = cv2.dilate(white, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    # Полоса вдоль берега — тоже стена: пунктир часто не доходит до берега
    wall[(land > 0) & (cv2.erode(land, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))) == 0)] = 1

    # Ячейки суши между стенами; подписи — ячейке, которой больше всего под рамкой подписи
    free = ((land > 0) & (wall == 0)).astype(np.uint8)
    nc, cell = cv2.connectedComponents(free, connectivity=4)
    area = np.bincount(cell.ravel(), minlength=nc)
    min_cell = land.sum() * 0.002
    owner = {}
    seed_xy = {}
    for i in seeds:
        l = labels[i]
        under = cell[l["y0"]:l["y1"], l["x0"]:l["x1"]][free[l["y0"]:l["y1"], l["x0"]:l["x1"]] > 0]
        votes = np.bincount(under, minlength=nc) if under.size else np.zeros(nc, int)
        votes[area < min_cell] = 0
        votes[0] = 0
        if votes.max() == 0:
            continue
        c = int(votes.argmax())
        ys, xs = np.nonzero(cell == c)
        x, y = center(l)
        j = ((xs - x) ** 2 + (ys - y) ** 2).argmin()
        seed_xy[i] = (int(xs[j]), int(ys[j]))
        owner.setdefault(c, []).append(i)

    # Водораздел по удалённости от стен: страны встречаются на стенах, в щелях — в самом узком месте
    markers = np.zeros((H, W), np.int32)
    for c, idx in owner.items():
        if len(idx) == 1:
            markers[cell == c] = idx[0] + 1
            continue
        for i in idx:
            l = labels[i]
            box = np.zeros((H, W), bool)
            box[l["y0"]:l["y1"], l["x0"]:l["x1"]] = True
            markers[box & (cell == c)] = i + 1
            cv2.circle(markers, seed_xy[i], 6, i + 1, -1)
    markers[land == 0] = 0
    dist = cv2.distanceTransform(free, cv2.DIST_L2, 5)
    reg = watershed(-dist, markers, mask=land > 0) - 1

    # Подпись без своей границы («Конфедерация монстров» над лесом Джура): если общая граница с соседом почти вся
    # проведена водоразделом по открытой земле (по стенам < 30%), меньшая область сливается с ним
    alias = {}
    while True:
        tot, on = {}, {}
        for a, b, w in ((reg[:, :-1], reg[:, 1:], wall[:, :-1] | wall[:, 1:]), (reg[:-1], reg[1:], wall[:-1] | wall[1:])):
            m = (a != b) & (a >= 0) & (b >= 0)
            pairs = np.stack([np.minimum(a[m], b[m]), np.maximum(a[m], b[m])], 1)
            for (i, j), onw in zip(map(tuple, pairs), w[m]):
                tot[(i, j)] = tot.get((i, j), 0) + 1
                on[(i, j)] = on.get((i, j), 0) + int(onw)
        weak = [(k_, on[k_] / tot[k_]) for k_ in tot if tot[k_] > 30 and on[k_] / tot[k_] < 0.3]
        if not weak:
            break
        (i, j), _ = min(weak, key=lambda w: w[1])
        small, big = (i, j) if (reg == i).sum() < (reg == j).sum() else (j, i)
        alias[int(small)] = int(big)
        reg[reg == small] = big
    root = lambda i: root(alias[i]) if i in alias else i

    # Раскраска: соседи по общей границе — разных цветов (жадно, начиная со стран с большим числом соседей)
    nbr = {}
    for i, j in tot:
        nbr.setdefault(int(i), set()).add(int(j))
        nbr.setdefault(int(j), set()).add(int(i))
    color = {}
    for i in sorted(nbr, key=lambda i: -len(nbr[i])):
        used = {color[j] for j in nbr[i] if j in color}
        color[i] = next(c for c in range(len(nbr) + 1) if c not in used)

    regions = []
    for i in seeds:
        if i in alias:
            regions.append(dict(label=i, alias=root(i), polys=[]))
        elif i in seed_xy:
            m = ((reg == i) & (land > 0)).astype(np.uint8)
            polys = _contours(m)
            if not polys:
                continue
            # Место для названия страны — самая удалённая от краёв точка (в широкой части, а не в перешейке)
            d = cv2.distanceTransform(m, cv2.DIST_L2, 5)
            y, x = np.unravel_index(int(d.argmax()), d.shape)
            regions.append(dict(label=i, alias=None, polys=polys, color=color.get(i, 0), anchor=[int(x), int(y), float(d[y, x])]))
    return dict(width=W, height=H, land=_contours(land), regions=regions)
