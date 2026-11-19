#!/usr/bin/env python3
"""Бэкап конфигов всех сервисов и .env в один архив, для переноса на другую машину.

    python scripts/backup.py              # остановит контейнеры на время архивации
    python scripts/backup.py --no-stop    # без остановки (базы SQLite могут быть несогласованы)

Медиа (DATA_ROOT) не входят: их копируют отдельно (rsync) или скачивают заново.
"""
import argparse
import os
import subprocess
import tarfile
import time
from pathlib import Path

from common import ENV_FILE, ROOT, load_env, resolve

# Кэши, логи, миниатюры: восстанавливаются сами, а весят гигабайты
EXCLUDE_DIRS = {"jellyfin-cache", "logs", "log", "transcodes", "cache", "MediaCover",
                "Backups", "backups", "metadata", "Sentry", "gluetun",
                "Definitions",
                # Модели Ollama — гигабайты, скачиваются заново (bootstrap.py --only ollama)
                "ollama"}
EXCLUDE_SUFFIXES = (".pid", ".log", ".db-shm", ".db-wal")


def add_tree(tar: tarfile.TarFile, root: Path, arcname: str) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            if name.endswith(EXCLUDE_SUFFIXES):
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            try:
                tar.add(path, arcname=f"{arcname}/{rel}", recursive=False)
            except OSError:
                # Сокеты (qBittorrent ipc-socket) и прочие спецфайлы не архивируются
                print(f"  пропущен {rel}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-stop", action="store_true")
    parser.add_argument("--out", default=str(ROOT / "backups"))
    args = parser.parse_args()

    env = load_env()
    config_root = resolve(env["CONFIG_ROOT"])
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / f"home-theater-{time.strftime('%Y%m%d-%H%M')}.tar.gz"

    # Календарь: согласованный логический дамп PostgreSQL, включая историю миграций.
    # Выполняется до остановки БД; файл входит в архив конфигов. Пароль не передаётся в argv.
    if env.get("DATABASE_DRIVER", "postgres") != "sqlite":
        subprocess.run(["docker", "compose", "exec", "-T", "anime-calendar", "node", "database/backup.mjs"],
                       cwd=ROOT, check=True)

    # Authentik (учётки, приглашения) — в Postgres на именованном томе: дамп в config/authentik/db.sql, пока база работает.
    # Восстановление: docker exec -i authentik-db psql -U authentik authentik < config/authentik/db.sql
    dump = subprocess.run(["docker", "exec", "authentik-db", "pg_dump", "-U", "authentik", "authentik"], capture_output=True)
    if dump.returncode == 0:
        (config_root / "authentik").mkdir(parents=True, exist_ok=True)
        (config_root / "authentik" / "db.sql").write_bytes(dump.stdout)
        print(f"+ дамп Authentik ({len(dump.stdout) / 1e6:.1f} МБ)")

    if not args.no_stop:
        subprocess.run(["docker", "compose", "stop"], cwd=ROOT, check=True)
    try:
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(ENV_FILE, arcname=".env")
            add_tree(tar, config_root, "config")
    finally:
        if not args.no_stop:
            subprocess.run(["docker", "compose", "start"], cwd=ROOT, check=True)

    print(f"Готово: {archive} ({archive.stat().st_size / 1e6:.1f} МБ)")


if __name__ == "__main__":
    main()
