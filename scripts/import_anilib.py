#!/usr/bin/env python3
"""Импорт закладок AniLib (animelib.org) в список аниме-календаря.

  python scripts/import_anilib.py 7392528            — отчёт: что и как будет импортировано
  python scripts/import_anilib.py 7392528 --apply    — записать в список (вход — JELLYFIN_ADMIN_* из .env)
  python scripts/import_anilib.py 7392528 --apply --user <логин> --password <пароль>  — в список другого пользователя
  --map 21800=113290   — ручное сопоставление «ID тайтла AniLib = ID AniList», если поиск не нашёл

AniLib за геоблоком: нужен доступ мимо VPN (scripts/split-tunnel). Закладки берутся из публичного
Lib-API; у тайтлов обычно есть anilist_id, остальные ищутся в AniList по названию.
Правило слияния: AniLib главнее — статус и прогресс перезаписываются, оценка и впечатления не трогаются.
Оценки AniLib публично не отдаёт.
"""
import argparse
import http.cookiejar
import json
import time
import urllib.error
import urllib.request

from common import load_env

LIB_API = "https://api.cdnlibs.org/api"
LIB_HEADERS = {
    # Без браузерных Referer/Origin Lib-API отвечает 403
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    "Site-Id": "5",  # 5 — AniLib
    "Referer": "https://v5.animelib.org/",
    "Origin": "https://v5.animelib.org",
    "Accept": "application/json",
}
ANILIST = "https://graphql.anilist.co"
# AniList отклоняет (403) запросы со стандартным User-Agent urllib
ANILIST_HEADERS = {"User-Agent": "anime-calendar-import/1.0", "Accept": "application/json"}
CALENDAR = "http://localhost:5056"

# Папки AniLib → статусы календаря (по названию: id папок у каждого пользователя свои)
FOLDERS = {
    "смотрю": "watching",
    "запланировано": "planned",
    "в планах": "planned",
    "просмотрено": "completed",
    "брошено": "dropped",
    "отложено": "on_hold",
    "пересматриваю": "rewatching",
}


def get_json(url: str, headers: dict | None = None, data: dict | None = None, method: str | None = None, opener=None, timeout: int = 30):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={**(headers or {}), **({"Content-Type": "application/json"} if body else {})})
    with (opener.open(req, timeout=timeout) if opener else urllib.request.urlopen(req, timeout=timeout)) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def lib_bookmarks(user_id: int) -> tuple[list[dict], dict[int, str]]:
    folders = {f["id"]: f["name"] for f in get_json(f"{LIB_API}/bookmarks/folder/{user_id}", LIB_HEADERS)["data"]}
    items, page = [], 1
    while True:
        d = get_json(f"{LIB_API}/bookmarks?user_id={user_id}&status=0&page={page}", LIB_HEADERS)
        items += d["data"]
        if not d["meta"].get("next_page_url") or not d["data"]:
            break
        page += 1
        time.sleep(0.4)
    return items, folders


SEARCH = """query ($q: String) { Page(perPage: 5) { media(search: $q, type: ANIME) {
  id format seasonYear episodes title { romaji english native } } } }"""


def anilist_search(*names: str) -> list[dict]:
    """Кандидаты из AniList по названию (оригинальное → английское). Лимит AniList — 30 запросов в минуту."""
    for name in filter(None, names):
        for attempt in range(3):
            try:
                found = get_json(ANILIST, ANILIST_HEADERS, data={"query": SEARCH, "variables": {"q": name}})["data"]["Page"]["media"]
                time.sleep(2.1)
                if found:
                    return found
                break
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(int(e.headers.get("Retry-After", "30")) + 1)
    return []


def plan(items: list[dict], folders: dict[int, str], manual: dict[int, int]) -> tuple[list[dict], list[str]]:
    rows, problems = [], []
    for b in items:
        m = b["media"]
        title = m.get("rus_name") or m.get("name")
        folder = folders.get(b["status"], f"папка {b['status']}")
        status = FOLDERS.get(folder.strip().lower())
        if not status:
            problems.append(f"«{title}»: неизвестная папка «{folder}» — пропускаю")
            continue
        anilist_id, how = m.get("anilist_id"), "anilist_id"
        if m["id"] in manual:
            anilist_id, how = manual[m["id"]], "вручную (--map)"
        if not anilist_id:
            found = anilist_search(m.get("name"), m.get("eng_name"))
            if not found:
                problems.append(f"«{title}» ({m.get('name')}, AniLib {m['id']}): не найдено в AniList — пропускаю (сопоставь вручную: --map {m['id']}=<id AniList>)")
                continue
            anilist_id, how = found[0]["id"], f"поиск → {found[0]['title']['romaji']} ({found[0].get('seasonYear') or '?'}, {found[0].get('format')})"
        # Прогресс: номер последней просмотренной серии (у просмотренного календарь проставит все)
        episodes = (b.get("meta") or {}).get("item_number") or 0
        rows.append({"anilistId": anilist_id, "status": status, "episodes": episodes, "title": title, "folder": folder, "how": how})
    return rows, problems


def login(user: str, password: str):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    get_json(f"{CALENDAR}/api/auth/login", data={"username": user, "password": password}, opener=opener)
    return opener


def main() -> None:
    ap = argparse.ArgumentParser(description="Импорт закладок AniLib в список аниме-календаря")
    ap.add_argument("lib_user_id", type=int, help="ID пользователя AniLib (из адреса профиля /user/<id>)")
    ap.add_argument("--apply", action="store_true", help="записать в список (без флага — только отчёт)")
    ap.add_argument("--user", help="логин Jellyfin, в чей список импортировать (по умолчанию — админ из .env)")
    ap.add_argument("--password", help="пароль этого пользователя")
    ap.add_argument("--map", action="append", default=[], metavar="LIB=ANILIST", help="ручное сопоставление ID тайтла AniLib и AniList")
    args = ap.parse_args()

    items, folders = lib_bookmarks(args.lib_user_id)
    print(f"AniLib: {len(items)} закладок")
    manual = {int(k): int(v) for k, v in (m.split("=") for m in args.map)}
    rows, problems = plan(items, folders, manual)

    by_status: dict[str, int] = {}
    for r in rows:
        by_status[r["folder"]] = by_status.get(r["folder"], 0) + 1
    print("К импорту:", ", ".join(f"{k} — {v}" for k, v in by_status.items()))
    searched = [r for r in rows if r["how"] != "anilist_id"]
    if searched:
        print("\nСопоставлено поиском по названию (проверь):")
        for r in searched:
            print(f"  «{r['title']}» → {r['how']} · anilist {r['anilistId']}")
    if problems:
        print("\nПроблемы:")
        for p in problems:
            print("  " + p)

    if not args.apply:
        print("\nЭто отчёт. Записать: добавь --apply")
        return

    env = load_env()
    opener = login(args.user or env["JELLYFIN_ADMIN_USER"], args.password or env["JELLYFIN_ADMIN_PASSWORD"])
    current = {e["anilistId"]: e for e in get_json(f"{CALENDAR}/api/list", opener=opener)}
    done = failed = 0
    for i, r in enumerate(rows, 1):
        patch = {"status": r["status"]}
        if r["episodes"] and r["status"] != "completed":
            patch["episodes"] = r["episodes"]
        old = current.get(r["anilistId"])
        if old and old["status"] == patch["status"] and old.get("episodes", 0) >= patch.get("episodes", 0):
            continue
        # Календарь на каждую запись догружает тайтл из AniList (лимит 30/мин) — ответ бывает долгим
        for attempt in range(3):
            try:
                get_json(f"{CALENDAR}/api/list/{r['anilistId']}", data=patch, method="PUT", opener=opener, timeout=180)
                done += 1
                break
            except TimeoutError:
                if attempt == 2:
                    failed += 1
                    print(f"  ✗ «{r['title']}»: таймаут")
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"  ✗ «{r['title']}»: HTTP {e.code} {e.read().decode()[:200]}")
                break
        if i % 10 == 0:
            print(f"  … {i}/{len(rows)}")
    print(f"\nГотово: записано {done}, ошибок {failed}, без изменений {len(rows) - done - failed}")


if __name__ == "__main__":
    main()
