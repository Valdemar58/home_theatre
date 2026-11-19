#!/usr/bin/env python3
"""Импорт списка AnimeGo (animego.me) в список аниме-календаря — разово, по образцу import_anilib.py.

  python scripts/import_animego.py 112130 --fetch            — выгрузить список через прокси в config/anime-calendar/import/
  python scripts/import_animego.py 112130                    — отчёт: что совпало, что новое, где добавятся оценки
  python scripts/import_animego.py 112130 --apply            — записать по правилу слияния (вход — JELLYFIN_ADMIN_* из .env)
  --map 1146=101922   — ручное сопоставление «ID тайтла AnimeGo = ID AniList»

AnimeGo закрыт в РФ и Германии: ходим через отдельный прокси (--proxy, по умолчанию 127.0.0.1:10870 — контейнер
xray с выходом в Польшу, только для этого скрипта; системный прокси и VPN-клиент не трогаются).
Профиль — по числовому id (animego.me/user/<id>), список открыт всем, по 10 записей на страницу вкладки.
Серии AnimeGo не хранит (у всех «0 / N») — переносятся статус и оценка (1–10, как в календаре).
Правило слияния (AniLib и текущий список главнее): новые тайтлы добавляются со статусом и оценкой; у тайтлов,
которые уже есть, только ставится оценка, если её нет. Статус существующих не меняется — расхождения в отчёте.
"""
import argparse
import html
import http.cookiejar
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request

from common import ROOT, load_env

ANILIST = "https://graphql.anilist.co"
ANILIST_HEADERS = {"User-Agent": "anime-calendar-import/1.0", "Accept": "application/json"}
CALENDAR = "http://localhost:5056"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0"
DATA = ROOT / "config" / "anime-calendar" / "import"

# Вкладки AnimeGo → статусы календаря (по названию вкладки)
TABS = {"смотрю": "watching", "просмотрено": "completed", "отложено": "on_hold", "брошено": "dropped",
        "запланировано": "planned", "пересматриваю": "rewatching"}
# Тип на странице тайтла AnimeGo → формат AniList
FORMATS = {"тв сериал": "TV", "фильм": "MOVIE", "ova": "OVA", "ona": "ONA", "спешл": "SPECIAL", "короткометражный": "TV_SHORT", "клип": "MUSIC"}


def text(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", s or "").lower()
    return re.sub(r"[^a-z0-9а-яё]+", "", "".join(c for c in s if not unicodedata.combining(c)))


def opener_for(proxy: str):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
    op.addheaders = [("User-Agent", UA)]
    return op


def fetch_list(user: int, proxy: str) -> list[dict]:
    op = opener_for(proxy)
    get = lambda url: op.open(url, timeout=40).read().decode("utf-8")
    profile = get(f"https://animego.me/user/{user}")
    tabs = {m.group(1): re.sub(r"\s*\d+$", "", text(m.group(2))) for m in re.finditer(r'href="/user/\d+\?type=(\d)"[^>]*>(.*?)</a>', profile, re.S)}
    rows = []
    for t, label in tabs.items():
        page = 1
        while True:
            items = re.split(r'<div id="profile-my-list-entry-', get(f"https://animego.me/user/mylist/{user}/{page}?type={t}"))[1:]
            for it in items:
                slug = re.search(r'href="/anime/([^"#]+)"', it).group(1)
                orig = re.search(r'mb-2 text-line-clamp"[^>]*>(.*?)</div>', it, re.S)
                rating = re.search(r"data-rating-value[^>]*>\s*(\d+)\s*<", it)
                rows.append({"tab": label, "slug": slug, "id": int(slug.rsplit("-", 1)[1]),
                             "title": text(re.search(r"user-mylist__title.*?<a[^>]*>(.*?)</a>", it, re.S).group(1)),
                             "original": text(orig.group(1)) if orig else None, "score": int(rating.group(1)) if rating else None})
            if len(items) < 10:
                break
            page += 1
            time.sleep(0.7)
        print(f"  {label}: {sum(r['tab'] == label for r in rows)}")
    return rows


def title_info(slug: str, proxy: str, cache: dict) -> dict:
    """Тип, год начала и число серий со страницы тайтла AnimeGo (для выбора среди кандидатов AniList)."""
    if slug not in cache:
        try:
            h = opener_for(proxy).open(f"https://animego.me/anime/{slug}", timeout=40).read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as e:
            # Страницы нет (снята по требованию правообладателя) — ищем только по названию
            print(f"  страница {slug}: {e}")
            return {"format": None, "year": None, "episodes": None}
        plain = text(re.sub(r"(?s)<(script|style)\b.*?</\1>", " ", h))
        kind = re.search(r"Тип (.+?) (?:Эпизоды|Жанры|Статус)", plain)
        year = re.search(r"Выпуск\D{0,40}?(\d{4})", plain)
        eps = re.search(r"Эпизоды (\d+)", plain)
        cache[slug] = {"format": FORMATS.get((kind.group(1) if kind else "").strip().lower()),
                       "year": int(year.group(1)) if year else None, "episodes": int(eps.group(1)) if eps else None}
        time.sleep(0.5)
    return cache[slug]


SEARCH = """query ($q: String) { Page(perPage: 8) { media(search: $q, type: ANIME) {
  id format seasonYear episodes title { romaji english native } synonyms } } }"""


def anilist_search(name: str, cache: dict) -> list[dict]:
    """Кандидаты AniList (ответы — в кэше: перезапуск после сбоя продолжает с того же места)."""
    key = f"q:{name}"
    if key in cache:
        return cache[key]
    for attempt in range(6):
        try:
            req = urllib.request.Request(ANILIST, data=json.dumps({"query": SEARCH, "variables": {"q": name}}).encode(),
                                         headers={**ANILIST_HEADERS, "Content-Type": "application/json"})
            found = json.load(urllib.request.urlopen(req, timeout=60))["data"]["Page"]["media"]
            time.sleep(2.1)
            cache[key] = found
            return found
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(int(e.headers.get("Retry-After", "30")) + 1)
        except (urllib.error.URLError, TimeoutError) as e:
            # AniList через VPN отвечает медленно и иногда не открывает TLS — подождать и повторить
            print(f"  AniList: {e}, повтор {attempt + 1}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise SystemExit("AniList не отвечает — запусти отчёт позже, найденное сохранено")


CACHE_FILE = None


def save_cache(cache: dict) -> None:
    if CACHE_FILE:
        CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def names_of(m: dict) -> set[str]:
    t = m.get("title") or {}
    return {norm(x) for x in [t.get("romaji"), t.get("english"), t.get("native"), *(m.get("synonyms") or [])] if x}


def match(rows: list[dict], current: list[dict], manual: dict[int, int], proxy: str, cache: dict) -> list[dict]:
    """Сначала — с тем, что уже в списке календаря (по оригинальному названию), потом поиск AniList с проверкой типа и года."""
    mine = {}
    for e in current:
        for n in names_of(e.get("media") or {}):
            mine.setdefault(n, e["anilistId"])
    out = []
    for r in rows:
        r = dict(r)
        if r["id"] in manual:
            r.update(anilistId=manual[r["id"]], how="вручную (--map)")
        elif norm(r["original"]) in mine:
            r.update(anilistId=mine[norm(r["original"])], how="уже в списке")
        else:
            info = title_info(r["slug"], proxy, cache)
            cands = anilist_search(r["original"] or r["title"], cache)
            save_cache(cache)
            fits = lambda c: (not info["format"] or c.get("format") == info["format"]) and (not info["year"] or abs((c.get("seasonYear") or 0) - info["year"]) <= 1)
            exact = [c for c in cands if norm(r["original"]) in names_of(c) and fits(c)]
            loose = [c for c in cands if fits(c)]
            pick = (exact or loose or [None])[0]
            if pick:
                r.update(anilistId=pick["id"], how=("поиск, название совпало" if exact else "поиск, проверь") +
                         f" → {pick['title']['romaji']} ({pick.get('seasonYear')}, {pick.get('format')})")
            else:
                r.update(anilistId=None, how=f"не найдено (AnimeGo: {info['format']}, {info['year']})")
        out.append(r)
        if len(out) % 25 == 0:
            print(f"  … сопоставлено {len(out)}/{len(rows)}", flush=True)
    return out


def get_json(url: str, opener, data=None, method=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, method=method,
                                 headers={"Content-Type": "application/json"} if data is not None else {})
    with opener.open(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def login(user: str, password: str):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    get_json(f"{CALENDAR}/api/auth/login", op, data={"username": user, "password": password})
    return op


def main() -> None:
    ap = argparse.ArgumentParser(description="Импорт списка AnimeGo в список аниме-календаря")
    ap.add_argument("animego_user", type=int, help="числовой id профиля AnimeGo (animego.me/user/<id>)")
    ap.add_argument("--fetch", action="store_true", help="выгрузить список заново через прокси")
    ap.add_argument("--proxy", default="http://127.0.0.1:10870", help="прокси с выходом туда, где AnimeGo открыт")
    ap.add_argument("--apply", action="store_true", help="записать (без флага — только отчёт)")
    ap.add_argument("--map", action="append", default=[], metavar="ANIMEGO=ANILIST")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    global CACHE_FILE
    raw_file, plan_file, cache_file = (DATA / f"animego-{args.animego_user}{s}.json" for s in ("", "-plan", "-titles"))
    CACHE_FILE = cache_file
    if args.fetch or not raw_file.exists():
        print("AnimeGo:")
        raw_file.write_text(json.dumps(fetch_list(args.animego_user, args.proxy), ensure_ascii=False, indent=1), encoding="utf-8")
    rows = json.loads(raw_file.read_text(encoding="utf-8"))
    # Выгрузка первой версии (status вместо tab, с числом в названии вкладки)
    for r in rows:
        r.setdefault("tab", re.sub(r"\s*\d+$", "", r.get("status", "")))
    print(f"Записей AnimeGo: {len(rows)}, с оценкой: {sum(r['score'] is not None for r in rows)}")

    env = load_env()
    op = login(env["JELLYFIN_ADMIN_USER"], env["JELLYFIN_ADMIN_PASSWORD"])
    current = get_json(f"{CALENDAR}/api/list", op)
    by_id = {e["anilistId"]: e for e in current}
    cache = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.exists() else {}
    manual = {int(k): int(v) for k, v in (m.split("=") for m in args.map)}
    plan = match(rows, current, manual, args.proxy, cache)
    cache_file.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    plan_file.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")

    new, scores, differ, check, missing = [], [], [], [], []
    for r in plan:
        status = TABS.get(r["tab"].strip().lower())
        if not r["anilistId"]:
            missing.append(r)
            continue
        if "проверь" in r["how"]:
            check.append(r)
        old = by_id.get(r["anilistId"])
        if not old:
            new.append((r, status))
        else:
            if r["score"] and not old.get("score"):
                scores.append(r)
            if status and old["status"] != status:
                differ.append((r, old["status"], status))
    print(f"\nУже в списке: {len(plan) - len(new) - len(missing)} · новых: {len(new)} · не найдено: {len(missing)}")
    print(f"Оценок добавится: {len(scores)} · статус в календаре другой (не меняется): {len(differ)}")
    print("Новые по статусам:", ", ".join(f"{s} — {sum(1 for _, x in new if x == s)}" for s in sorted({x for _, x in new})))
    if check:
        print("\nСопоставлено поиском без точного совпадения названия (проверь):")
        for r in check:
            print(f"  «{r['title']}» / {r['original']} → {r['how']} · anilist {r['anilistId']}")
    if missing:
        print("\nНе найдено (сопоставь вручную: --map <id AnimeGo>=<id AniList>):")
        for r in missing:
            print(f"  «{r['title']}» / {r['original']} · AnimeGo {r['id']} · {r['how']}")
    if differ:
        print("\nСтатус расходится (оставляю календарный):")
        for r, a, b in differ:
            print(f"  «{r['title']}»: календарь {a}, AnimeGo {b}")

    if not args.apply:
        print(f"\nЭто отчёт (план — {plan_file}). Записать: добавь --apply")
        return
    done = failed = 0
    for r, status in new:
        patch = {"status": status, **({"score": r["score"]} if r["score"] else {})}
        done, failed = put(op, r, patch, done, failed)
    for r in scores:
        done, failed = put(op, r, {"score": r["score"]}, done, failed)
    print(f"\nГотово: записано {done}, ошибок {failed}")


def put(op, r: dict, patch: dict, done: int, failed: int) -> tuple[int, int]:
    # Календарь на новую запись догружает тайтл из AniList (лимит 30/мин) — ответ бывает долгим
    for attempt in range(3):
        try:
            get_json(f"{CALENDAR}/api/list/{r['anilistId']}", op, data=patch, method="PUT", timeout=180)
            return done + 1, failed
        except TimeoutError:
            continue
        except urllib.error.HTTPError as e:
            print(f"  ✗ «{r['title']}»: HTTP {e.code} {e.read().decode()[:200]}")
            return done, failed + 1
    print(f"  ✗ «{r['title']}»: таймаут")
    return done, failed + 1


if __name__ == "__main__":
    main()
