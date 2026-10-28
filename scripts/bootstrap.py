#!/usr/bin/env python3
"""Автонастройка всех сервисов через их API. Идемпотентный: можно запускать повторно.

    python scripts/bootstrap.py                 # все шаги
    python scripts/bootstrap.py --only formats  # только озвучки/студии из profiles.toml
    python scripts/bootstrap.py --list          # список шагов

Скрипт работает с хоста (обращается к localhost:<порт>), а в настройки
сервисов прописывает внутренние docker-имена (sonarr:8989, qbittorrent:8080...).
"""
import argparse
import http.client
import http.cookiejar
import json
import re
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

from common import ROOT, load_env, resolve

ENV = load_env()
HOST = "localhost"

# Внутренние адреса (как сервисы видят друг друга в docker-сети)
INTERNAL = {
    "sonarr": ("sonarr", 8989),
    "radarr": ("radarr", 7878),
    "prowlarr": ("prowlarr", 9696),
    "qbittorrent": ("qbittorrent", 8080),
    "jellyfin": ("jellyfin", 8096),
}
MEDIA = {"movies": "/data/media/movies", "tv": "/data/media/tv", "anime": "/data/media/anime"}
QBIT_CATEGORIES = {"radarr": "/data/torrents/movies",
                   "tv-sonarr": "/data/torrents/tv",
                   "anime": "/data/torrents/anime"}
JELLYFIN_LIBRARIES = [("Фильмы", "movies", MEDIA["movies"]),
                      ("Сериалы", "tvshows", MEDIA["tv"]),
                      ("Аниме", "tvshows", MEDIA["anime"]),
                      # «Смотреть сейчас» из календаря: .strm-ссылки на поток из TorrServer
                      ("Стрим", "tvshows", "/data/media/stream")]


# ---------------------------------------------------------------- HTTP

class ApiError(Exception):
    pass


class Api:
    def __init__(self, port: int, headers: dict | None = None):
        self.base = f"http://{HOST}:{port}"
        self.headers = headers or {}
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, method, path, json_body=None, form=None, params=None, raw=False):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        headers = dict(self.headers)
        body = None
        if form is not None:
            body = urllib.parse.urlencode(form, doseq=True).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif json_body is not None:
            body = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=120) as resp:
                text = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:600]
            raise ApiError(f"{method} {path} -> HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            raise ApiError(f"{method} {url}: {e.reason}") from None
        except (http.client.HTTPException, ConnectionError, TimeoutError) as e:
            # Сервис ещё стартует (например, Sonarr мигрирует базу) и рвёт соединение
            raise ApiError(f"{method} {url}: {e!r}") from None
        if raw:
            return text
        return json.loads(text) if text.strip() else None

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, json_body=body, **kw)

    def put(self, path, body=None, **kw):
        return self.request("PUT", path, json_body=body, **kw)


def wait_for(name: str, port: int, path: str, timeout: int = 240) -> None:
    deadline = time.time() + timeout
    api = Api(port)
    while True:
        try:
            api.request("GET", path, raw=True)
            return
        except ApiError as e:
            # 401 тоже значит, что сервис поднялся
            if "HTTP 401" in str(e):
                return
            if time.time() > deadline:
                raise ApiError(f"{name} не ответил за {timeout} c: {e}")
            time.sleep(3)


def log(msg: str) -> None:
    print(f"  {msg}")


def set_fields(resource: dict, values: dict) -> None:
    """Заполняет поля provider-ресурса *arr (fields: [{name, value}])."""
    names = {f["name"] for f in resource.get("fields", [])}
    for f in resource.get("fields", []):
        if f["name"] in values:
            f["value"] = values[f["name"]]
    missing = set(values) - names
    if missing:
        log(f"! у {resource.get('implementation') or resource.get('name')} нет полей: {sorted(missing)}")


def from_schema(api: Api, schema_path: str, implementation: str) -> dict:
    for item in api.get(schema_path):
        if item.get("implementation") == implementation:
            return item
    raise ApiError(f"в {schema_path} нет реализации {implementation}")


def upsert_provider(api: Api, path: str, resource: dict) -> None:
    """Создаёт или обновляет provider (download client, indexer, app...) по имени."""
    existing = next((x for x in api.get(path) if x["name"] == resource["name"]), None)
    params = {"forceSave": "true"}
    if existing:
        resource["id"] = existing["id"]
        api.put(f"{path}/{existing['id']}", resource, params=params)
        log(f"= {resource['name']} обновлён")
    else:
        api.post(path, resource, params=params)
        log(f"+ {resource['name']} создан")


def ensure_tag(api: Api, version: str, label: str) -> int:
    for tag in api.get(f"/api/{version}/tag"):
        if tag["label"] == label:
            return tag["id"]
    return api.post(f"/api/{version}/tag", {"label": label})["id"]


# ---------------------------------------------------------------- qBittorrent

def step_qbittorrent() -> None:
    port = int(ENV.get("QBIT_WEBUI_PORT", 8090))
    api = Api(port)
    wait_for("qBittorrent", port, "/")
    api.request("POST", "/api/v2/auth/login", raw=True,
                form={"username": ENV["QBIT_USER"], "password": ENV["QBIT_PASSWORD"]})
    # Ответ на логин зависит от версии ("Ok." или пустой 204), поэтому проверяем сессию
    try:
        version = api.request("GET", "/api/v2/app/version", raw=True)
    except ApiError:
        raise ApiError("не удалось войти в qBittorrent. Если конфиг был создан до init.py, "
                       "задай логин/пароль в WebUI (Tools → Options → WebUI) такие же, как в .env") from None
    log(f"= qBittorrent {version}")
    prefs = {
        "save_path": "/data/torrents",
        "temp_path_enabled": False,
        "auto_tmm_enabled": True,             # путь берётся из категории
        "torrent_changed_tmm_enabled": True,
        "category_changed_tmm_enabled": True,
        "incomplete_files_ext": True,
        "listen_port": int(ENV.get("TORRENT_PORT", 6881)),
        "upnp": False,
    }
    api.request("POST", "/api/v2/app/setPreferences", raw=True, form={"json": json.dumps(prefs)})
    existing = api.get("/api/v2/torrents/categories") or {}
    for name, path in QBIT_CATEGORIES.items():
        endpoint = "editCategory" if name in existing else "createCategory"
        api.request("POST", f"/api/v2/torrents/{endpoint}", raw=True,
                    form={"category": name, "savePath": path})
        log(f"= категория {name} → {path}")


# ---------------------------------------------------------------- Sonarr / Radarr

def arr_api(kind: str) -> Api:
    port = INTERNAL[kind][1]
    return Api(port, {"X-Api-Key": ENV[f"{kind.upper()}_API_KEY"]})


def qbit_client(api: Api, kind: str, name: str, category: str, tags: list[int]) -> dict:
    client = from_schema(api, "/api/v3/downloadclient/schema", "QBittorrent")
    prefix = "tv" if kind == "sonarr" else "movie"
    set_fields(client, {
        "host": INTERNAL["qbittorrent"][0],
        "port": INTERNAL["qbittorrent"][1],
        "username": ENV["QBIT_USER"],
        "password": ENV["QBIT_PASSWORD"],
        f"{prefix}Category": category,
    })
    client.update(name=name, enable=True, priority=1, tags=tags,
                  removeCompletedDownloads=True, removeFailedDownloads=True)
    return client


def configure_arr(kind: str) -> None:
    api = arr_api(kind)
    wait_for(kind, INTERNAL[kind][1], "/ping")

    # Root-папки
    roots = [MEDIA["tv"], MEDIA["anime"]] if kind == "sonarr" else [MEDIA["movies"]]
    have = {r["path"].rstrip("/") for r in api.get("/api/v3/rootfolder")}
    for path in roots:
        if path not in have:
            api.post("/api/v3/rootfolder", {"path": path})
            log(f"+ root-папка {path}")

    # Hardlinks и импорт субтитров, лежащих рядом с видео
    mm = api.get("/api/v3/config/mediamanagement")
    mm.update(copyUsingHardlinks=True, importExtraFiles=True,
              extraFileExtensions="srt,ass,ssa,sub,idx")
    api.put(f"/api/v3/config/mediamanagement/{mm['id']}", mm)
    log("= hardlinks + импорт extra-файлов включены")

    # Имена файлов/папок с ID: Jellyfin безошибочно находит метаданные
    naming = api.get("/api/v3/config/naming")
    if kind == "sonarr":
        naming.update(
            renameEpisodes=True,
            replaceIllegalCharacters=True,
            standardEpisodeFormat="{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} [{Custom Formats }{Quality Full}]{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioLanguages]}-{Release Group}",
            animeEpisodeFormat="{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000} - {Episode CleanTitle} [{Custom Formats }{Quality Full}]{[Mediainfo AudioLanguages]}-{Release Group}",
            seriesFolderFormat="{Series TitleYear} [tvdbid-{TvdbId}]",
            seasonFolderFormat="Season {season:00}",
        )
    else:
        naming.update(
            renameMovies=True,
            replaceIllegalCharacters=True,
            standardMovieFormat="{Movie CleanTitle} {(Release Year)} [{Custom Formats }{Quality Full}]{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioLanguages]}-{Release Group}",
            movieFolderFormat="{Movie CleanTitle} ({Release Year}) [tmdbid-{TmdbId}]",
        )
    api.put(f"/api/v3/config/naming/{naming['id']}", naming)
    log("= схема имён настроена")

    # Клиенты загрузки
    if kind == "sonarr":
        anime_tag = ensure_tag(api, "v3", "anime")
        upsert_provider(api, "/api/v3/downloadclient",
                        qbit_client(api, kind, "qBittorrent", "tv-sonarr", []))
        # Сериалы с тегом anime уходят в отдельную категорию
        upsert_provider(api, "/api/v3/downloadclient",
                        qbit_client(api, kind, "qBittorrent (anime)", "anime", [anime_tag]))
        configure_extra_tracks_script(api)
    else:
        upsert_provider(api, "/api/v3/downloadclient",
                        qbit_client(api, kind, "qBittorrent", "radarr", []))


def configure_extra_tracks_script(api: Api) -> None:
    hook = from_schema(api, "/api/v3/notification/schema", "CustomScript")
    set_fields(hook, {"path": "/scripts/extra-tracks.sh"})
    for key, value in list(hook.items()):
        if key.startswith("on") and isinstance(value, bool):
            hook[key] = False
    hook.update(name="Extra tracks (озвучки/сабы)", onDownload=True, onUpgrade=True)
    upsert_provider(api, "/api/v3/notification", hook)


def step_sonarr() -> None:
    configure_arr("sonarr")


def step_radarr() -> None:
    configure_arr("radarr")


# ---------------------------------------------------------------- Prowlarr

# (definitionName, env-префикс учётки или None, нужен FlareSolverr, доп. поля, язык)
# Язык определяет маршрут: "en" синхронизируется в Sonarr напрямую, "ru" разбирает
# RU-индексатор календаря (Sonarr не понимает названия русских раздач), None — только Prowlarr.
INDEXERS = [
    # Встроенный индексатор Prowlarr. Названия оставляем как есть: их разбирает ru-indexer
    # календаря (apps/anime-calendar), а преобразования Prowlarr только мешают.
    # FlareSolverr: страница входа RuTracker закрыта проверкой Cloudflare
    ("rutracker.org", "RUTRACKER", True,
     {"russianLetters": False, "addRussianToTitle": False,
      "moveFirstTagsToEndOfReleaseTitle": False, "moveAllTagsToEndOfReleaseTitle": False}, "ru"),
    ("kinozal", "KINOZAL", False, {}, "ru"),
    # У RuTor в Prowlarr сломаны категории (всё «Other»), поэтому только ручной поиск в Prowlarr
    ("rutor", None, False, {}, None),
    ("nyaasi", None, False, {}, "en"),
    ("1337x", None, True, {}, "en"),
]


def step_prowlarr() -> None:
    api = Api(9696, {"X-Api-Key": ENV["PROWLARR_API_KEY"]})
    wait_for("prowlarr", 9696, "/ping")

    cf_tag = ensure_tag(api, "v1", "flaresolverr")
    lang_tags = {"ru": ensure_tag(api, "v1", "ru"), "en": ensure_tag(api, "v1", "en")}
    proxy = from_schema(api, "/api/v1/indexerproxy/schema", "FlareSolverr")
    set_fields(proxy, {"host": "http://flaresolverr:8191/", "requestTimeout": 60})
    proxy.update(name="FlareSolverr", tags=[cf_tag])
    upsert_provider(api, "/api/v1/indexerproxy", proxy)

    for kind in ("sonarr", "radarr"):
        app = from_schema(api, "/api/v1/applications/schema", kind.capitalize())
        host, port = INTERNAL[kind]
        set_fields(app, {"prowlarrUrl": "http://prowlarr:9696",
                         "baseUrl": f"http://{host}:{port}",
                         "apiKey": ENV[f"{kind.upper()}_API_KEY"]})
        # Sonarr получает только индексаторы с тегом en; русские раздачи идут через RU-индексатор.
        # Radarr без тегов: получает все (названия фильмов с RuTracker он разбирает сам)
        app.update(name=kind.capitalize(), syncLevel="fullSync", tags=[lang_tags["en"]] if kind == "sonarr" else [])
        upsert_provider(api, "/api/v1/applications", app)

    app_profile = api.get("/api/v1/appprofile")[0]["id"]
    schema = {i.get("definitionName", "").lower(): i for i in api.get("/api/v1/indexer/schema")}
    existing = {i.get("definitionName", "").lower(): i for i in api.get("/api/v1/indexer")}
    for definition, cred, needs_cf, extra, lang in INDEXERS:
        values = dict(extra)
        if cred:
            user, password = ENV.get(f"{cred}_USER"), ENV.get(f"{cred}_PASSWORD")
            if not (user and password):
                log(f"- {definition}: нет {cred}_USER/{cred}_PASSWORD в .env, пропускаю")
                continue
            values.update(username=user, password=password)
        base = existing.get(definition) or schema.get(definition)
        if not base:
            log(f"- {definition}: нет такого индексатора в этой версии Prowlarr")
            continue
        names = {f["name"] for f in base.get("fields", [])}
        set_fields(base, {k: v for k, v in values.items() if k in names})
        tags = ([cf_tag] if needs_cf else []) + ([lang_tags[lang]] if lang else [])
        base.update(enable=True, appProfileId=app_profile, tags=tags)
        try:
            if "id" in base:
                api.put(f"/api/v1/indexer/{base['id']}", base, params={"forceSave": "true"})
                log(f"= индексатор {base['name']} обновлён")
            else:
                api.post("/api/v1/indexer", base, params={"forceSave": "true"})
                log(f"+ индексатор {base['name']} добавлен")
        except ApiError as e:
            log(f"! {definition}: {e}")

    api.post("/api/v1/command", {"name": "ApplicationIndexerSync"})
    log("= индексаторы синхронизируются в Sonarr/Radarr")


# ---------------------------------------------------------------- Recyclarr + свои форматы

def step_recyclarr() -> None:
    cmd = ["docker", "compose", "run", "--rm", "--no-deps", "recyclarr", "sync"]
    log("$ " + " ".join(cmd))
    if subprocess.run(cmd, cwd=ROOT).returncode != 0:
        raise ApiError("recyclarr sync завершился с ошибкой (см. вывод выше)")


def load_profiles() -> dict:
    with open(ROOT / "profiles.toml", "rb") as f:
        return tomllib.load(f)


def upsert_custom_formats(api: Api, formats: list[dict]) -> dict[str, int]:
    existing = {cf["name"]: cf for cf in api.get("/api/v3/customformat")}
    ids = {}
    # Одно имя = один формат; записи без regex только задают балл в своём профиле
    unique = {}
    for fmt in formats:
        if fmt.get("regex"):
            unique.setdefault(fmt["name"], fmt)
    for fmt in unique.values():
        body = {
            "name": fmt["name"],
            "includeCustomFormatWhenRenaming": False,
            "specifications": [{
                "name": fmt["name"],
                "implementation": "ReleaseTitleSpecification",
                "negate": False,
                "required": False,
                "fields": [{"name": "value", "value": fmt["regex"]}],
            }],
        }
        if fmt["name"] in existing:
            body["id"] = existing[fmt["name"]]["id"]
            api.put(f"/api/v3/customformat/{body['id']}", body)
        else:
            body["id"] = api.post("/api/v3/customformat", body)["id"]
        ids[fmt["name"]] = body["id"]
    return ids


ANIME_PROFILE = "Anime RU"


def ensure_anime_profile(api: Api) -> None:
    """Свой профиль для аниме: 720p–1080p (WEB/BD/Remux), без порога по баллам.

    Профиль TRaSH для аниме не подходит русским релизам: у него minFormatScore 100
    и формат «Dubs Only» с баллом -10000.
    """
    profiles = api.get("/api/v3/qualityprofile")
    if any(p["name"] == ANIME_PROFILE for p in profiles):
        return
    base = next((p for p in profiles if p["name"] == "Any"), profiles[0])
    wanted = {"HDTV-720p", "HDTV-1080p", "WEBDL-720p", "WEBRip-720p", "WEBDL-1080p",
              "WEBRip-1080p", "Bluray-720p", "Bluray-1080p", "Bluray-1080p Remux"}
    cutoff = None

    def walk(items):
        nonlocal cutoff
        for item in items:
            if item.get("items"):
                walk(item["items"])
                item["allowed"] = any(i["allowed"] for i in item["items"])
            else:
                item["allowed"] = item["quality"]["name"] in wanted
                if item["quality"]["name"] == "Bluray-1080p":
                    cutoff = item["quality"]["id"]
            if item.get("items") and "Bluray-1080p" in {i["quality"]["name"] for i in item["items"]}:
                cutoff = item["id"]

    profile = json.loads(json.dumps(base))
    walk(profile["items"])
    profile.pop("id", None)
    profile.update(name=ANIME_PROFILE, upgradeAllowed=True, minFormatScore=0,
                   cutoffFormatScore=10000, minUpgradeFormatScore=1)
    if cutoff is not None:
        profile["cutoff"] = cutoff
    api.post("/api/v3/qualityprofile", profile)
    log(f"+ профиль «{ANIME_PROFILE}» создан")


def apply_scores(api: Api, kind: str, prefs: dict) -> None:
    general = prefs.get("general", [])
    anime = prefs.get("anime", []) if kind == "sonarr" else []
    ids = upsert_custom_formats(api, general + anime)
    log(f"= {len(ids)} custom formats в {kind}")
    if kind == "sonarr":
        ensure_anime_profile(api)

    any_language = None
    if kind == "radarr":
        any_language = next((l for l in api.get("/api/v3/language") if l["name"] == "Any"), None)

    for profile in api.get("/api/v3/qualityprofile"):
        is_anime = profile["name"] == ANIME_PROFILE
        scores = {f["name"]: f["score"] for f in (anime if is_anime else general)}
        # Форматы другой группы в этом профиле обнуляем
        other = {f["name"] for f in (general if is_anime else anime)}
        for item in profile.get("formatItems", []):
            if item["name"] in scores:
                item["score"] = scores[item["name"]]
            elif item["name"] in other:
                item["score"] = 0
        # Фильмы на любом языке (RU-дубляж не должен отсекаться фильтром "Original")
        if any_language and "language" in profile:
            profile["language"] = any_language
        api.put(f"/api/v3/qualityprofile/{profile['id']}", profile)
        log(f"= профиль «{profile['name']}»: баллы {'аниме' if is_anime else 'общие'}")


def step_formats() -> None:
    prefs = load_profiles()
    for kind in ("sonarr", "radarr"):
        apply_scores(arr_api(kind), kind, prefs)


# ---------------------------------------------------------------- Jellyfin

JF_AUTH = 'MediaBrowser Client="home-theater-bootstrap", Device="script", DeviceId="ht-bootstrap", Version="1.0"'


def jellyfin_login() -> tuple[Api, str]:
    api = Api(8096, {"Authorization": JF_AUTH})
    res = api.post("/Users/AuthenticateByName",
                   {"Username": ENV["JELLYFIN_ADMIN_USER"], "Pw": ENV["JELLYFIN_ADMIN_PASSWORD"]})
    api.headers["Authorization"] = JF_AUTH + f', Token="{res["AccessToken"]}"'
    return api, res["User"]["Id"]


def step_jellyfin() -> None:
    wait_for("jellyfin", 8096, "/health")
    api = Api(8096, {"Authorization": JF_AUTH})
    if not api.get("/System/Info/Public").get("StartupWizardCompleted"):
        api.post("/Startup/Configuration", {"UICulture": "ru", "MetadataCountryCode": "RU",
                                            "PreferredMetadataLanguage": "ru"})
        api.get("/Startup/User")
        api.post("/Startup/User", {"Name": ENV["JELLYFIN_ADMIN_USER"],
                                   "Password": ENV["JELLYFIN_ADMIN_PASSWORD"]})
        api.post("/Startup/RemoteAccess", {"EnableRemoteAccess": True,
                                           "EnableAutomaticPortMapping": False})
        api.post("/Startup/Complete")
        log("+ мастер первого запуска пройден")

    api, user_id = jellyfin_login()

    # Имя сервера: иначе Jellyfin берёт имя хоста — id контейнера (его видно в заголовке вкладки)
    name = ENV.get("JELLYFIN_SERVER_NAME") or "Домашний кинотеатр"
    sys_cfg = api.get("/System/Configuration")
    if sys_cfg.get("ServerName") != name:
        sys_cfg["ServerName"] = name
        api.post("/System/Configuration", sys_cfg)
        log(f"= имя сервера: {name}")

    have = {lib["Name"] for lib in api.get("/Library/VirtualFolders")}
    for name, ctype, path in JELLYFIN_LIBRARIES:
        if name in have:
            continue
        api.post("/Library/VirtualFolders",
                 {"LibraryOptions": {"PreferredMetadataLanguage": "ru",
                                     "MetadataCountryCode": "RU",
                                     "EnableRealtimeMonitor": True,
                                     "PathInfos": [{"Path": path}]}},
                 params={"name": name, "collectionType": ctype, "refreshLibrary": "true"})
        log(f"+ библиотека «{name}» → {path}")

    # Предпочтения дорожек: язык озвучки и субтитров
    jf = load_profiles().get("jellyfin", {})
    user = api.get(f"/Users/{user_id}")
    cfg = user["Configuration"]
    cfg.update(AudioLanguagePreference=jf.get("audio_language", "rus"),
               SubtitleLanguagePreference=jf.get("subtitle_language", "rus"),
               SubtitleMode=jf.get("subtitle_mode", "Smart"),
               PlayDefaultAudioTrack=False)
    try:
        api.post("/Users/Configuration", cfg, params={"userId": user_id})
    except ApiError:
        api.post(f"/Users/{user_id}/Configuration", cfg)
    log("= предпочтения аудио/субтитров сохранены")

    # Аппаратное ускорение по выбранному в COMPOSE_FILE override
    compose_files = ENV.get("COMPOSE_FILE", "")
    accel = "nvenc" if "nvidia" in compose_files else "qsv" if "intel" in compose_files else None
    if accel:
        enc = api.get("/System/Configuration/encoding")
        enc.update(HardwareAccelerationType=accel,
                   EnableHardwareEncoding=True,
                   HardwareDecodingCodecs=["h264", "hevc", "mpeg2video", "vc1", "vp8", "vp9", "av1"],
                   EnableDecodingColorDepth10Hevc=True,
                   EnableDecodingColorDepth10Vp9=True,
                   EnableTonemapping=True)
        if accel == "qsv":
            enc["VaapiDevice"] = "/dev/dri/renderD128"
        api.post("/System/Configuration/encoding", enc)
        log(f"= аппаратное транскодирование: {accel}")

    # Миниатюры на шкале плеера (trickplay): только по опорным кадрам, с ускорением, плановой задачей (ночью), а не
    # при сканировании. Кроме «Стрима»: Jellyfin пришлось бы выкачать раздачу целиком
    sys_cfg = api.get("/System/Configuration")
    sys_cfg["TrickplayOptions"].update(EnableHwAcceleration=bool(accel), EnableHwEncoding=bool(accel), EnableKeyFrameOnlyExtraction=True)
    api.post("/System/Configuration", sys_cfg)
    for lib in api.get("/Library/VirtualFolders"):
        if lib["Name"] == "Стрим":
            continue
        opts = {**lib["LibraryOptions"], "EnableTrickplayImageExtraction": True, "ExtractTrickplayImagesDuringLibraryScan": False}
        api.post("/Library/VirtualFolders/LibraryOptions", {"Id": lib["ItemId"], "LibraryOptions": opts})
    log("= миниатюры шкалы (trickplay) — во всех библиотеках, кроме «Стрима»")

    # Ключ API для календаря: сканирование библиотеки «Стрим» и ссылки на сериалы
    if not ENV.get("JELLYFIN_API_KEY"):
        api.post("/Auth/Keys", params={"app": "anime-calendar"})
        keys = api.get("/Auth/Keys")["Items"]
        key = next(k["AccessToken"] for k in keys if k.get("AppName") == "anime-calendar")
        set_env_value("JELLYFIN_API_KEY", key)
        log("+ JELLYFIN_API_KEY для календаря записан в .env")


# ---------------------------------------------------------------- TorrServer

def step_torrserver() -> None:
    api = Api(8092)
    wait_for("torrserver", 8092, "/echo")
    settings = api.post("/settings", {"action": "get"})
    settings.update(
        # Фиксированный порт для входящих соединений пиров (проброшен в compose): так поток быстрее
        PeersListenPort=6882,
        # Кэш на диске (/cache = DATA_ROOT/torrserver-cache): серию можно «подготовить» целиком
        # заранее (календарь → «Загрузки»), в памяти помещалось 256 МБ. 16 ГБ — пара серий BDRemux
        UseDisk=True,
        TorrentsSavePath="/cache",
        CacheSize=16 * 1024 ** 3,
        # Кэш раздачи остаётся после её остановки — подготовленная серия не теряется
        RemoveCacheOnDrop=False,
        PreloadCache=25,
        ReaderReadAHead=95,
        # 25 соединений мало для быстрого старта: с хорошей раздачи берём больше пиров
        ConnectionsLimit=100,
    )
    api.post("/settings", {"action": "set", "sets": settings})
    log("= TorrServer: порт пиров 6882, кэш 16 ГБ на диске, 100 соединений")


# ---------------------------------------------------------------- Ollama

# Модели с HuggingFace: CDN HF доступен напрямую
# (~30 МБ/с), а файлы реестра Ollama (Cloudflare R2) — только через VPN. Скачанное копируется
# под именем из .env, поэтому код и LLM_MODEL/EMBED_MODEL не меняются.
# Переопределить: LLM_MODEL_SOURCE / EMBED_MODEL_SOURCE (пусто = реестр Ollama).
MODEL_SOURCES = {
    "qwen3.5:9b": "hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    # Q8_0 вместо F16 библиотеки Ollama: вдвое меньше, векторы почти те же (косинус ~0.999).
    # Тег — только стандартное имя кванта (FP16 HF не принимает)
    "bge-m3": "hf.co/gpustack/bge-m3-GGUF:Q8_0",
}


def ollama_call(path: str, body: dict, method: str = "POST", timeout: int = 3600) -> dict:
    req = urllib.request.Request(f"http://{HOST}:11434{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def step_ollama() -> None:
    """Скачать модели для рекомендаций (несколько гигабайт, один раз)."""
    wait_for("ollama", 11434, "/api/tags")
    have = {m["name"] for m in Api(11434).get("/api/tags")["models"]}
    models = ((ENV.get("LLM_MODEL") or "qwen3.5:9b", "LLM_MODEL_SOURCE"),
              (ENV.get("EMBED_MODEL") or "bge-m3", "EMBED_MODEL_SOURCE"))
    for model, source_key in models:
        if model in have or f"{model}:latest" in have:
            log(f"= {model} уже скачана")
            continue
        source = ENV.get(source_key, MODEL_SOURCES.get(model, ""))
        if source:
            log(f"… скачиваю {model} с {source} (может занять несколько минут)")
            try:
                ollama_call("/api/pull", {"model": source, "stream": False})
                ollama_call("/api/copy", {"source": source, "destination": model})
                # Файлы общие с копией — удаляется только лишнее имя
                ollama_call("/api/delete", {"model": source}, method="DELETE")
                log(f"+ {model}: скачана с {source}")
                continue
            except (urllib.error.URLError, TimeoutError) as e:
                log(f"! {source}: {e} — пробую реестр Ollama")
        log(f"… скачиваю {model} из реестра Ollama (может занять несколько минут)")
        status = ollama_call("/api/pull", {"model": model, "stream": False}).get("status")
        log(f"+ {model}: {status}")


# ---------------------------------------------------------------- Bazarr

def bazarr_api_key() -> str:
    path = resolve(ENV["CONFIG_ROOT"]) / "bazarr" / "config" / "config.yaml"
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line[0].isspace():
            section = line.rstrip(":").strip()
        elif section == "auth" and line.strip().startswith("apikey:"):
            return line.split(":", 1)[1].strip().strip("'\"")
    raise ApiError(f"не нашёл auth.apikey в {path}")


def step_bazarr() -> None:
    wait_for("bazarr", 6767, "/")
    deadline = time.time() + 60
    while True:
        try:
            key = bazarr_api_key()
            break
        except (ApiError, FileNotFoundError):
            if time.time() > deadline:
                raise
            time.sleep(3)
    api = Api(6767, {"X-API-KEY": key})
    langs = load_profiles().get("bazarr", {}).get("languages", ["ru", "en"])
    profile = {
        "profileId": 1,
        "name": "/".join(l.upper() for l in langs),
        "cutoff": None,
        # audio_only_include — обязательное поле в новых версиях Bazarr (иначе KeyError → HTTP 500)
        "items": [{"id": i + 1, "language": l, "audio_exclude": "False", "audio_only_include": "False",
                   "hi": "False", "forced": "False"} for i, l in enumerate(langs)],
        "mustContain": [],
        "mustNotContain": [],
        "originalFormat": False,
    }
    form = {
        "settings-general-use_sonarr": "true",
        "settings-sonarr-ip": "sonarr",
        "settings-sonarr-port": "8989",
        "settings-sonarr-base_url": "/",
        "settings-sonarr-apikey": ENV["SONARR_API_KEY"],
        "settings-general-use_radarr": "true",
        "settings-radarr-ip": "radarr",
        "settings-radarr-port": "7878",
        "settings-radarr-base_url": "/",
        "settings-radarr-apikey": ENV["RADARR_API_KEY"],
        "languages-enabled": langs,
        "languages-profiles": json.dumps([profile]),
        "settings-general-serie_default_enabled": "true",
        "settings-general-serie_default_profile": "1",
        "settings-general-movie_default_enabled": "true",
        "settings-general-movie_default_profile": "1",
    }
    api.request("POST", "/api/system/settings", form=form, raw=True)
    log(f"= Bazarr подключён к Sonarr/Radarr, языки: {', '.join(langs)}")
    log("  провайдеров субтитров (OpenSubtitles, Jimaku...) включи в UI: им нужны свои аккаунты")


# ---------------------------------------------------------------- Seerr

def pick(items: list[dict], key: str, wanted: str, contains: str | None = None) -> dict:
    for item in items:
        if item[key] == wanted:
            return item
    if contains:
        for item in items:
            if contains in item[key].lower():
                return item
    return items[0]


def step_seerr() -> None:
    wait_for("seerr", 5055, "/api/v1/status")
    api = Api(5055)
    if api.get("/api/v1/settings/public").get("initialized"):
        log("= Seerr уже инициализирован, пропускаю")
        return

    creds = {"username": ENV["JELLYFIN_ADMIN_USER"], "password": ENV["JELLYFIN_ADMIN_PASSWORD"],
             "email": ENV.get("SEERR_ADMIN_EMAIL", "admin@home.local")}
    try:
        api.post("/api/v1/auth/jellyfin", {**creds, "hostname": "jellyfin", "port": 8096,
                                           "useSsl": False, "urlBase": "", "serverType": 2})
    except ApiError as e:
        if "already configured" not in str(e):
            raise
        # Повторный запуск: сервер уже привязан, входим только по логину
        api.post("/api/v1/auth/jellyfin", creds)
    log("+ вход через Jellyfin выполнен")

    libs = api.post("/api/v1/settings/jellyfin/library/sync")
    for lib in libs:
        api.put(f"/api/v1/settings/jellyfin/library/{lib['id']}", {"enabled": True})
    log(f"= библиотеки: {', '.join(l['name'] for l in libs)}")

    for kind in ("sonarr", "radarr"):
        host, port = INTERNAL[kind]
        conn = {"hostname": host, "port": port, "apiKey": ENV[f"{kind.upper()}_API_KEY"],
                "useSsl": False, "baseUrl": ""}
        info = api.post(f"/api/v1/settings/{kind}/test", conn)
        profiles = info["profiles"]
        body = {**conn, "name": kind.capitalize(), "is4k": False, "isDefault": True,
                "syncEnabled": True, "preventSearch": False, "tags": [],
                "externalUrl": f"http://localhost:{port}"}
        if kind == "sonarr":
            main = pick(profiles, "name", "WEB-2160p")
            anime = pick(profiles, "name", ANIME_PROFILE, contains="anime")
            anime_tag = next((t["id"] for t in info.get("tags", []) if t["label"] == "anime"), None)
            body.update(activeProfileId=main["id"], activeProfileName=main["name"],
                        activeDirectory=MEDIA["tv"],
                        activeAnimeProfileId=anime["id"], activeAnimeProfileName=anime["name"],
                        activeAnimeDirectory=MEDIA["anime"],
                        animeTags=[anime_tag] if anime_tag is not None else [],
                        seriesType="standard", animeSeriesType="anime",
                        enableSeasonFolders=True)
        else:
            main = pick(profiles, "name", "UHD Bluray + WEB")
            body.update(activeProfileId=main["id"], activeProfileName=main["name"],
                        activeDirectory=MEDIA["movies"], minimumAvailability="released")
        existing = next((x for x in api.get(f"/api/v1/settings/{kind}") if x["hostname"] == host), None)
        if existing:
            api.put(f"/api/v1/settings/{kind}/{existing['id']}", body)
            log(f"= {kind}: профиль «{main['name']}» (обновлён)")
        else:
            api.post(f"/api/v1/settings/{kind}", body)
            log(f"+ {kind}: профиль «{main['name']}»")

    api.post("/api/v1/settings/main", {"locale": "ru"})
    api.post("/api/v1/settings/initialize")
    log("+ Seerr инициализирован")


# ---------------------------------------------------------------- Аниме-календарь

TMDB_ANIME_KEYWORD = "210024"
# Типы полок Seerr: TMDB_TV_KEYWORD = 15, TMDB_MOVIE_KEYWORD = 13
SEERR_ANIME_SLIDERS = [(15, "Аниме-сериалы"), (13, "Аниме-фильмы")]


def set_env_value(key: str, value: str) -> None:
    env_file = ROOT / ".env"
    text = env_file.read_text(encoding="utf-8")
    text, n = re.subn(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
    if not n:
        text += f"\n{key}={value}\n"
    env_file.write_text(text, encoding="utf-8", newline="\n")
    ENV[key] = value


def step_anime_calendar() -> None:
    settings = resolve(ENV["CONFIG_ROOT"]) / "seerr" / "settings.json"
    api_key = json.loads(settings.read_text(encoding="utf-8"))["main"]["apiKey"]
    changed = ENV.get("SEERR_API_KEY") != api_key
    if changed:
        set_env_value("SEERR_API_KEY", api_key)
        log("+ SEERR_API_KEY записан в .env")

    # Полки «Аниме» на главной Seerr (ключевое слово TMDB «anime»)
    seerr = Api(5055, {"X-Api-Key": api_key})
    sliders = seerr.get("/api/v1/settings/discover")
    titles = {s.get("title") for s in sliders}
    added = False
    for slider_type, title in SEERR_ANIME_SLIDERS:
        if title not in titles:
            seerr.post("/api/v1/settings/discover/add", {"title": title, "type": slider_type, "data": TMDB_ANIME_KEYWORD})
            log(f"+ полка «{title}» на главной Seerr")
            added = True
    if added:
        # Новые полки создаются выключенными: включаем их, не трогая остальные
        sliders = seerr.get("/api/v1/settings/discover")
        for s in sliders:
            if s.get("title") in {t for _, t in SEERR_ANIME_SLIDERS}:
                s["enabled"] = True
        seerr.post("/api/v1/settings/discover", sliders)

    if changed:
        # Пересоздать контейнер, чтобы он увидел новый ключ
        subprocess.run(["docker", "compose", "up", "-d", "anime-calendar"], cwd=ROOT, check=True)
    wait_for("anime-calendar", 5056, "/login")

    # RU-индексатор календаря в Sonarr: раздачи RuTracker/Kinozal с понятными Sonarr названиями
    sonarr = arr_api("sonarr")
    indexer = from_schema(sonarr, "/api/v3/indexer/schema", "Torznab")
    set_fields(indexer, {
        "baseUrl": "http://anime-calendar:5056/api/torznab/ru",
        "apiPath": "/api",
        "apiKey": ENV["ANIME_CALENDAR_TORZNAB_KEY"],
        "categories": [5000, 5070],
        "animeCategories": [5070],
        "animeStandardFormatSearch": True,
    })
    # Приоритет выше, чем у английских трекеров (меньше число — выше приоритет)
    indexer.update(name="RU трекеры (anime-calendar)", enableRss=True, enableAutomaticSearch=True,
                   enableInteractiveSearch=True, priority=10)
    upsert_provider(sonarr, "/api/v3/indexer", indexer)
    log("= календарь: http://localhost:5056 (вход логином Jellyfin)")


# ---------------------------------------------------------------- main

STEPS = {
    "qbittorrent": step_qbittorrent,
    "sonarr": step_sonarr,
    "radarr": step_radarr,
    "prowlarr": step_prowlarr,
    "recyclarr": step_recyclarr,
    "formats": step_formats,
    "jellyfin": step_jellyfin,
    "bazarr": step_bazarr,
    "seerr": step_seerr,
    "torrserver": step_torrserver,
    "ollama": step_ollama,
    "anime-calendar": step_anime_calendar,
}


def main() -> None:
    global HOST
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="шаги через запятую: " + ",".join(STEPS))
    parser.add_argument("--host", default="localhost", help="где запущен docker (по умолчанию localhost)")
    parser.add_argument("--list", action="store_true", help="показать шаги")
    args = parser.parse_args()
    if args.list:
        print("\n".join(STEPS))
        return
    HOST = args.host
    steps = args.only.split(",") if args.only else list(STEPS)
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        parser.error(f"неизвестные шаги: {unknown}")

    failed = []
    for name in steps:
        print(f"[{name}]")
        try:
            STEPS[name]()
        except (ApiError, KeyError, FileNotFoundError) as e:
            print(f"  ✗ {name}: {e}")
            failed.append(name)

    print()
    if failed:
        print(f"Шаги с ошибками: {', '.join(failed)}. Исправь и перезапусти: "
              f"python scripts/bootstrap.py --only {','.join(failed)}")
        sys.exit(1)
    print("Всё настроено. Открывай Seerr: http://localhost:5055  Jellyfin: http://localhost:8096")


if __name__ == "__main__":
    main()
