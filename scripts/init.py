#!/usr/bin/env python3
"""Подготовка машины к первому запуску.

- создаёт .env из .env.example и генерирует API-ключи и пароли;
- создаёт дерево каталогов для конфигов и медиа;
- кладёт стартовый конфиг qBittorrent с известным паролем, чтобы
  bootstrap.py мог подключиться без чтения временного пароля из логов.

Запуск повторно безопасен: существующие значения и файлы не трогаются.
"""
import base64
import hashlib
import os
import re
import secrets
import shutil
import sys

from common import ENV_EXAMPLE, ENV_FILE, ROOT, parse_env, resolve

CONFIG_DIRS = ["jellyfin", "jellyfin-cache", "seerr", "anime-calendar", "torrserver", "ollama", "sonarr", "radarr",
               "prowlarr", "bazarr", "qbittorrent", "gluetun", "mapvec"]
MEDIA_KINDS = ["movies", "tv", "anime"]
# Папка .strm-ссылок для «Смотреть сейчас» (только в media)
STREAM_DIR = "stream"

GENERATED = {
    "SONARR_API_KEY": lambda: secrets.token_hex(16),
    "RADARR_API_KEY": lambda: secrets.token_hex(16),
    "PROWLARR_API_KEY": lambda: secrets.token_hex(16),
    "JELLYFIN_ADMIN_PASSWORD": lambda: secrets.token_urlsafe(12),
    "QBIT_PASSWORD": lambda: secrets.token_urlsafe(12),
    "ANIME_CALENDAR_SECRET": lambda: secrets.token_urlsafe(32),
    "ANIME_CALENDAR_TORZNAB_KEY": lambda: secrets.token_hex(16),
}


def ensure_env() -> dict[str, str]:
    created = not ENV_FILE.exists()
    if created:
        shutil.copyfile(ENV_EXAMPLE, ENV_FILE)
        print(f"+ создан {ENV_FILE.name} из {ENV_EXAMPLE.name}")

    text = ENV_FILE.read_text(encoding="utf-8")
    env = parse_env(ENV_FILE)
    updates = {k: gen() for k, gen in GENERATED.items() if not env.get(k)}

    # На Linux сразу подставляем uid/gid текущего пользователя
    if created and hasattr(os, "getuid"):
        updates["PUID"] = str(os.getuid())
        updates["PGID"] = str(os.getgid())

    for key, value in updates.items():
        text, n = re.subn(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
        if not n:
            text += f"\n{key}={value}\n"
        print(f"+ {key} записан в .env")
    if updates:
        ENV_FILE.write_text(text, encoding="utf-8", newline="\n")
    return parse_env(ENV_FILE)


def ensure_dirs(env: dict[str, str]) -> None:
    config_root = resolve(env["CONFIG_ROOT"])
    data_root = resolve(env["DATA_ROOT"])
    paths = [config_root / d for d in CONFIG_DIRS]
    paths += [data_root / "torrents" / k for k in MEDIA_KINDS]
    paths += [data_root / "media" / k for k in MEDIA_KINDS]
    paths.append(data_root / "media" / STREAM_DIR)
    # Дисковый кэш TorrServer («подготовить серию»)
    paths.append(data_root / "torrserver-cache")
    for p in paths:
        p.mkdir(parents=True, exist_ok=True)
    print(f"+ каталоги готовы: CONFIG_ROOT={config_root}  DATA_ROOT={data_root}")


def qbit_password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, 100_000)
    return f"@ByteArray({base64.b64encode(salt).decode()}:{base64.b64encode(digest).decode()})"


def seed_qbittorrent(env: dict[str, str]) -> None:
    conf = resolve(env["CONFIG_ROOT"]) / "qbittorrent" / "qBittorrent" / "qBittorrent.conf"
    if conf.exists():
        print("= конфиг qBittorrent уже есть, не трогаю")
        return
    conf.parent.mkdir(parents=True, exist_ok=True)
    port = env.get("TORRENT_PORT", "6881")
    conf.write_text(rf"""[LegalNotice]
Accepted=true

[BitTorrent]
Session\DefaultSavePath=/data/torrents
Session\TempPathEnabled=false
Session\Port={port}
Session\AddExtensionToIncompleteFiles=true

[Preferences]
Downloads\SavePath=/data/torrents/
WebUI\Port=8080
WebUI\Username={env["QBIT_USER"]}
WebUI\Password_PBKDF2="{qbit_password_hash(env["QBIT_PASSWORD"])}"
WebUI\LocalHostAuth=false
WebUI\HostHeaderValidation=false
""", encoding="utf-8", newline="\n")
    print("+ стартовый конфиг qBittorrent создан")


def main() -> None:
    env = ensure_env()
    ensure_dirs(env)
    seed_qbittorrent(env)
    script = ROOT / "scripts" / "sonarr" / "extra-tracks.sh"
    if script.exists() and sys.platform != "win32":
        script.chmod(0o755)
    print("\nГотово. Дальше:\n"
          "  1) проверь .env (пути, COMPOSE_FILE, логины трекеров)\n"
          "  2) docker compose up -d\n"
          "  3) python scripts/bootstrap.py")


if __name__ == "__main__":
    main()
