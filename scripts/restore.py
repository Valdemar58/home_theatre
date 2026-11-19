#!/usr/bin/env python3
"""Восстановление из архива backup.py на новой машине.

    python scripts/restore.py backups/home-theater-YYYYMMDD-HHMM.tar.gz

- .env из архива кладётся, только если своего .env ещё нет
  (иначе сохраняется рядом как .env.from-backup, пути сравни вручную);
- конфиги распаковываются в CONFIG_ROOT из текущего .env.
Пути внутри контейнеров (/data/...) не меняются, поэтому DATA_ROOT
на новой машине может быть любым.
"""
import argparse
import subprocess
import sys
import tarfile
from pathlib import Path

from common import ENV_FILE, ROOT, parse_env, resolve


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive")
    args = parser.parse_args()

    with tarfile.open(args.archive, "r:gz") as tar:
        target_env = ENV_FILE if not ENV_FILE.exists() else ROOT / ".env.from-backup"
        target_env.write_bytes(tar.extractfile(".env").read())
        print(f"+ .env из архива → {target_env.name}")

        config_root = resolve(parse_env(ENV_FILE)["CONFIG_ROOT"])
        if config_root.exists() and any(config_root.iterdir()):
            answer = input(f"{config_root} не пуст, файлы будут перезаписаны. Продолжить? [y/N] ")
            if answer.lower() != "y":
                sys.exit("Отменено")
        subprocess.run(["docker", "compose", "down"], cwd=ROOT)

        members = []
        for m in tar.getmembers():
            if m.name.startswith("config/"):
                m.name = m.name[len("config/"):]
                members.append(m)
        config_root.mkdir(parents=True, exist_ok=True)
        tar.extractall(config_root, members=members, filter="data")
        print(f"+ конфиги распакованы в {config_root}")

    # Каталоги данных под новый DATA_ROOT
    subprocess.run([sys.executable, str(Path(__file__).with_name("init.py"))], cwd=ROOT, check=True)
    postgres_dump = config_root / "anime-calendar" / "postgres.dump"
    if postgres_dump.exists():
        print("+ дамп календаря PostgreSQL найден; восстанавливается только в пустую БД")
        current_env = parse_env(ENV_FILE)
        if not current_env.get("DATABASE_URL") and current_env.get("CALENDAR_DB_HOST", "calendar-db") == "calendar-db":
            subprocess.run(["docker", "compose", "up", "-d", "--wait", "calendar-db"], cwd=ROOT, check=True)
        subprocess.run(["docker", "compose", "run", "--rm", "--no-deps", "anime-calendar", "node", "database/restore.mjs"], cwd=ROOT, check=True)
    print("\nДальше: docker compose up -d")


if __name__ == "__main__":
    main()
