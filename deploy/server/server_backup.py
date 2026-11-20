"""Резервные копии: проверяемый архив и восстановление через новую БД."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile

FILES = ("installation.json", "server.env", "application.env", "compose.yml", "Caddyfile",
         "profiles.toml", "modules.json", "home_theater.py", "home-theater", "server_backup.py", "server_update.py")
EXCLUDED = {"stream", "img-cache", "pages", "thumbs", "lnreader"}
MEDIA = {".mkv", ".mp4", ".avi", ".mov", ".webm", ".m2ts", ".ts", ".mp3", ".flac", ".wav"}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def database_name(installation):
    name = installation.config().get("databaseName", "calendar")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", name):
        raise ValueError("Invalid database name in installation")
    return name


def sql(installation, query):
    return installation.compose("exec", "-T", "database", "psql", "-U", "calendar", "-d",
                                database_name(installation), "-v", "ON_ERROR_STOP=1", "-Atc", query, capture=True).strip()


def active_rooms(installation):
    return int(sql(installation, "SELECT count(*) FROM watch_rooms WHERE ended_at IS NULL AND last_activity > extract(epoch from now())::bigint - 120"))


@contextmanager
def stopped_writers(installation):
    running = installation.compose("ps", "--status", "running", "--services", capture=True).splitlines()
    writers = [name for name in ("application", "prowlarr") if name in running]
    if writers:
        installation.compose("stop", "--timeout", "60", *writers)
    try:
        yield
    finally:
        writers = [name for name in writers if name != "prowlarr" or "search" in installation.config()["modules"]]
        if writers:
            installation.compose("up", "-d", "--wait", "--wait-timeout", "180", *writers)


def copy_tree(source, destination, *, data=False):
    if not source.is_dir():
        return
    for directory, folders, filenames in os.walk(source, followlinks=False):
        here = Path(directory)
        folders[:] = [name for name in folders if not (here / name).is_symlink()
                      and (not data or here != source or name not in EXCLUDED)
                      and name not in ("logs", "Backups")]
        for name in filenames:
            path = here / name
            if path.is_symlink() or not path.is_file() or (data and path.suffix.lower() in MEDIA):
                continue
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(path, target)
            os.chmod(target, 0o600)


def binary_compose(installation, arguments, source=None, destination=None):
    with open(source, "rb") if source else open(os.devnull, "rb") as stdin:
        with open(destination, "wb") if destination else open(os.devnull, "wb") as stdout:
            result = subprocess.run(installation.compose_args(*arguments), stdin=stdin, stdout=stdout, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError("Database backup/restore command failed; existing database retained")


def verify_backup(source, destination=None):
    """Не используем extractall: запрещены ссылки, повторные и выходящие из каталога пути."""
    with tarfile.open(source, "r:gz") as archive:
        entries = archive.getmembers()
        names = [entry.name for entry in entries]
        if len(entries) > 100_000 or len(set(names)) != len(names):
            raise ValueError("Invalid backup file list")
        for entry in entries:
            path = PurePosixPath(entry.name)
            if not entry.isfile() or path.is_absolute() or ".." in path.parts or "\\" in entry.name or path.as_posix() != entry.name:
                raise ValueError("Unsafe path or link in backup")
            if entry.name != "manifest.json" and not (entry.name == "database.dump" or entry.name in FILES
                                                      or entry.name.startswith(("data/", "modules/prowlarr/"))):
                raise ValueError("Unexpected backup file")
        if "manifest.json" not in names:
            raise ValueError("Backup manifest missing")
        entry = archive.getmember("manifest.json")
        if entry.size > 8 * 1024 * 1024:
            raise ValueError("Backup manifest too large")
        manifest = json.load(archive.extractfile(entry))
        if manifest.get("formatVersion") != 1 or set(manifest.get("files", {})) != set(names) - {"manifest.json"}:
            raise ValueError("Unsupported or incomplete backup manifest")
        if not {"database.dump", "installation.json", "application.env", "server.env"} <= set(names):
            raise ValueError("Required backup files missing")
        if destination and sum(item.size for item in entries) > shutil.disk_usage(destination).free - 1024**3:
            raise RuntimeError("Insufficient free space to unpack backup")
        for entry in entries:
            stream = archive.extractfile(entry)
            checksum = hashlib.sha256()
            target = None
            if destination:
                path = destination / entry.name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                target = path.open("wb")
                os.chmod(path, 0o600)
            try:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    checksum.update(block)
                    if target:
                        target.write(block)
            finally:
                if target:
                    target.close()
            if entry.name != "manifest.json" and checksum.hexdigest() != manifest["files"][entry.name]:
                raise ValueError("Backup checksum mismatch")
        return manifest


def create_backup(installation, reason="manual", allow_active=False):
    if reason not in ("manual", "pre-update", "pre-restore", "daily"):
        raise ValueError("Invalid backup reason")
    if not allow_active and active_rooms(installation):
        raise RuntimeError("Active viewing rooms found; schedule maintenance before taking an offline backup")
    directory = installation.root / "backups"
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = directory / f"backup-{stamp}-{reason}-{secrets.token_hex(4)}.tar.gz"
    with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=directory) as temporary:
        stage = Path(temporary)
        with stopped_writers(installation):
            binary_compose(installation, ["exec", "-T", "database", "pg_dump", "-U", "calendar", "-d",
                                         database_name(installation), "--format=custom", "--no-owner", "--no-acl"],
                           destination=stage / "database.dump")
            for name in FILES:
                source = installation.root / name
                if source.is_file() and not source.is_symlink():
                    shutil.copyfile(source, stage / name)
            copy_tree(installation.root / "data", stage / "data", data=True)
            copy_tree(installation.root / "modules/prowlarr", stage / "modules/prowlarr")
        paths = sorted(path for path in stage.rglob("*") if path.is_file())
        manifest = {"formatVersion": 1, "createdAt": stamp, "reason": reason,
                    "image": installation.config()["image"], "excludedMedia": True,
                    "files": {path.relative_to(stage).as_posix(): digest(path) for path in paths}}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2))
        partial = stage / "archive.partial"
        with tarfile.open(partial, "w:gz", compresslevel=3) as archive:
            for path in [*paths, stage / "manifest.json"]:
                archive.add(path, arcname=path.relative_to(stage).as_posix(), recursive=False)
        verify_backup(partial)
        os.chmod(partial, 0o600)
        os.replace(partial, target)
    keep = {"daily": 7, "pre-update": 1}.get(reason)
    if keep:
        pattern = re.compile(r"^backup-\d{8}T\d{6}Z-" + re.escape(reason) + r"-[a-f0-9]{8}\.tar\.gz$")
        candidates = sorted((path for path in directory.iterdir() if pattern.fullmatch(path.name) and path.is_file() and not path.is_symlink()), reverse=True)
        for old in candidates[keep:]:
            old.unlink()
    print("Verified backup: " + str(target))
    return target


def chown_tree(root):
    for directory, folders, files in os.walk(root):
        os.chown(directory, 1000, 1000)
        os.chmod(directory, 0o700)
        for name in files:
            os.chown(Path(directory) / name, 1000, 1000)


def restore_backup(installation, source, *, allow_active=False, safety_backup=True):
    # Сначала проверяем архив и совместимость; до этого никакие работающие данные не меняются.
    config = installation.config()
    manifest = verify_backup(source)
    if manifest["image"] != config["image"]:
        raise ValueError("Restore requires the same server image; install the recorded image before restoring")
    if not allow_active and active_rooms(installation):
        raise RuntimeError("Active rooms found; restore requires a maintenance window")
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=installation.root) as temporary:
        stage = Path(temporary)
        verify_backup(source, stage)
        source_config = json.loads((stage / "installation.json").read_text())
        if not set(source_config["modules"]) <= {"search", "llm", "https"}:
            raise ValueError("Unknown modules in backup")
        new_database = "calendar_restore_" + secrets.token_hex(8)
        installation.compose("exec", "-T", "database", "createdb", "-U", "calendar", "-O", "calendar", new_database)
        binary_compose(installation, ["exec", "-T", "database", "pg_restore", "-U", "calendar", "-d", new_database,
                                     "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl"], source=stage / "database.dump")
        if safety_backup:
            create_backup(installation, "pre-restore", allow_active=allow_active)
        old_application = (installation.root / "application.env").read_bytes()
        old_server = (installation.root / "server.env").read_bytes()
        (stage / "data/stream").mkdir(parents=True, exist_ok=True)
        chown_tree(stage / "data")
        suffix = secrets.token_hex(6)
        saved_data = installation.root / ("data-before-restore-" + suffix)
        saved_prowlarr = installation.root / "modules" / ("prowlarr-before-restore-" + suffix)
        switched_data = switched_prowlarr = False
        with stopped_writers(installation):
            try:
                os.replace(installation.root / "data", saved_data)
                switched_data = True
                os.replace(stage / "data", installation.root / "data")
                if (stage / "modules/prowlarr").exists():
                    chown_tree(stage / "modules/prowlarr")
                    os.replace(installation.root / "modules/prowlarr", saved_prowlarr)
                    switched_prowlarr = True
                    os.replace(stage / "modules/prowlarr", installation.root / "modules/prowlarr")
                # Сохраняем пароль PostgreSQL, origin, порты и Compose project целевой установки.
                shutil.copyfile(stage / "application.env", installation.root / "application.env")
                restored = {**config, "databaseName": new_database,
                            "modules": [module for module in source_config["modules"] if module != "https"]}
                if config["origin"].startswith("https:"):
                    restored["modules"].append("https")
                installation.save(restored)
                installation.render(restored)
                installation.up()
            except Exception:
                installation.save(config)
                (installation.root / "application.env").write_bytes(old_application)
                (installation.root / "server.env").write_bytes(old_server)
                if switched_data:
                    if (installation.root / "data").exists():
                        os.replace(installation.root / "data", stage / "failed-data")
                    os.replace(saved_data, installation.root / "data")
                if switched_prowlarr:
                    if (installation.root / "modules/prowlarr").exists():
                        os.replace(installation.root / "modules/prowlarr", stage / "failed-prowlarr")
                    os.replace(saved_prowlarr, installation.root / "modules/prowlarr")
                installation.up()
                raise
    print("Restore verified; previous database retained: " + config.get("databaseName", "calendar"))


def daily_schedule(installation, enabled=None):
    root = str(installation.root)
    if not re.fullmatch(r"/[a-zA-Z0-9_/.-]+", root):
        raise ValueError("Daily schedule requires a simple absolute installation path")
    unit = "home-theater-backup-" + hashlib.sha256(root.encode()).hexdigest()[:12]
    service = Path("/etc/systemd/system") / (unit + ".service")
    timer = service.with_suffix(".timer")
    service.write_text("[Unit]\nDescription=home_theater daily backup\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nType=oneshot\nUMask=0077\n"
                       f"ExecStart={root}/home-theater --root {root} backup --reason daily\n")
    timer.write_text("[Unit]\nDescription=home_theater optional daily backup\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=15m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    if enabled is not None:
        subprocess.run(["systemctl", "enable" if enabled else "disable", "--now", unit + ".timer"], check=True)
    print("Daily backup timer installed; " + ("enabled state unchanged (off on a new installation)" if enabled is None else "enabled" if enabled else "disabled"))
