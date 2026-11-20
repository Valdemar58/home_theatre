#!/usr/bin/env python3
"""Установка и диагностика одного серверного продукта. Только стандартная библиотека."""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import tarfile
from urllib.parse import urlsplit
from urllib.request import urlopen
import xml.etree.ElementTree as ET

DEFAULT_ROOT = "/opt/home_theater"
IMAGE = re.compile(r"^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$")
INTEGRATIONS = {
    "JELLYFIN_URL": "", "JELLYFIN_API_KEY": "", "JELLYFIN_PUBLIC_URL": "",
    "SEERR_URL": "", "SEERR_API_KEY": "", "SEERR_PUBLIC_URL": "",
    "SONARR_URL": "", "SONARR_API_KEY": "", "SONARR_PUBLIC_URL": "",
    "RADARR_PUBLIC_URL": "", "BAZARR_PUBLIC_URL": "", "QBIT_URL": "",
    "QBIT_PUBLIC_URL": "", "QBIT_USER": "", "QBIT_PASSWORD": "",
    "TORRSERVER_URL": "", "TORRSERVER_INTERNAL_URL": "", "TORRSERVER_PUBLIC_URL": "",
    "AUTH_URL": "", "AUTH_PUBLIC_URL": "", "PROWLARR_PUBLIC_URL": "",
    "PROWLARR_URL": "", "PROWLARR_API_KEY": "", "FLARESOLVERR_URL": "",
    "OLLAMA_URL": "", "UPSCALER_URL": "", "MAPVEC_URL": "", "SUWAYOMI_URL": "",
}


def run(args, *, capture=False, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=capture)
    if result.returncode:
        # Вывод docker config/секретного окружения в сообщения ошибок не попадает.
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]}")
    return result.stdout if capture else ""


def atomic(path, content, mode=0o600):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path, value):
    atomic(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_env(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


def write_env(path, values):
    if any(not re.fullmatch(r"[A-Z][A-Z0-9_]*", k) or any(c in str(v) for c in "\r\n$'\"\\#")
           for k, v in values.items()):
        raise ValueError("Unsupported environment value; no shell interpolation is allowed")
    atomic(path, "".join(f"{k}={v}\n" for k, v in values.items()))


def validate_origin(value):
    url = urlsplit(value)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("Use an HTTP(S) origin without a path, credentials, query or fragment")
    try:
        port = url.port
    except ValueError as error:
        raise ValueError("Invalid origin port") from error
    loopback = url.hostname == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(url.hostname).is_loopback
    except ValueError:
        pass
    if url.scheme == "http" and not loopback:
        raise ValueError("HTTP is allowed only on loopback through an SSH tunnel")
    if url.scheme == "https" and (port not in (None, 443) or not re.fullmatch(r"[a-zA-Z0-9.-]+", url.hostname)):
        raise ValueError("Public HTTPS requires a DNS hostname on port 443")
    return value.rstrip("/")


def check_platform():
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "ubuntu" or release.get("VERSION_ID", "").strip('"') != "24.04":
        raise RuntimeError("Supported server platform: Ubuntu Server 24.04 x86_64")
    if os.uname().machine != "x86_64":
        raise RuntimeError("Server 1.0 supports x86_64 only")


def docker_install():
    if shutil.which("docker"):
        run(["docker", "compose", "version"], capture=True)
        run(["docker", "info", "--format", "{{.ServerVersion}}"], capture=True)
        return
    # Официальный APT-репозиторий Docker, без исполнения сетевого shell-скрипта.
    run(["apt-get", "update"])
    run(["apt-get", "install", "-y", "ca-certificates", "curl"])
    Path("/etc/apt/keyrings").mkdir(mode=0o755, exist_ok=True)
    run(["curl", "--fail", "--show-error", "--silent", "--location", "--proto", "=https", "--tlsv1.2",
         "https://download.docker.com/linux/ubuntu/gpg", "-o", "/etc/apt/keyrings/docker.asc"])
    os.chmod("/etc/apt/keyrings/docker.asc", 0o644)
    atomic("/etc/apt/sources.list.d/docker.sources",
           "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\n"
           "Architectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n", 0o644)
    run(["apt-get", "update"])
    run(["apt-get", "install", "-y", "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"])
    run(["systemctl", "enable", "--now", "docker"])


class Installation:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def config(self):
        return json.loads((self.root / "installation.json").read_text())

    def save(self, config):
        write_json(self.root / "installation.json", config)

    def compose(self, *args, capture=False):
        return run(self.compose_args(*args), capture=capture)

    def compose_args(self, *args):
        return ["docker", "compose", "--project-directory", str(self.root),
                "--env-file", str(self.root / "server.env"), "-f", str(self.root / "compose.yml"), *args]

    def render(self, config):
        values = read_env(self.root / "server.env")
        values.update(SERVER_IMAGE=config["image"], PUBLIC_URL=config["origin"],
                      PUBLIC_HOST=urlsplit(config["origin"]).hostname,
                      COOKIE_SECURE="1" if config["origin"].startswith("https:") else "0",
                      HTTP_PORT=str(config["httpPort"]), COMPOSE_PROJECT_NAME=config["project"],
                      DATABASE_NAME=config.get("databaseName", "calendar"),
                      COMPOSE_PROFILES=",".join(config["modules"]))
        values.update(config.get("images", {}))
        write_env(self.root / "server.env", values)
        application = read_env(self.root / "application.env")
        application["HOME_THEATER_MODULES"] = ",".join(config["modules"])
        application["OLLAMA_URL"] = "http://ollama:11434" if "llm" in config["modules"] else ""
        if "search" not in config["modules"]:
            application.update(PROWLARR_URL="", PROWLARR_API_KEY="")
        write_env(self.root / "application.env", application)

    def lock_images(self, config):
        # Сохраняем точные digest зависимостей: повторная установка не обновляет их молча.
        pairs = {"POSTGRES_IMAGE": "postgres:17-alpine"}
        if "https" in config["modules"]:
            pairs["PROXY_IMAGE"] = "caddy:2.10-alpine"
        if "search" in config["modules"]:
            pairs["PROWLARR_IMAGE"] = "lscr.io/linuxserver/prowlarr:latest"
        if "llm" in config["modules"]:
            pairs["OLLAMA_IMAGE"] = "ollama/ollama:latest"
        locked = config.setdefault("images", {})
        for key, image in pairs.items():
            if key not in locked:
                digests = json.loads(run(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"], capture=True))
                if not digests:
                    raise RuntimeError(f"No registry digest for {key}")
                locked[key] = digests[0]
        self.save(config)
        self.render(config)

    def up(self):
        config = self.config()
        self.render(config)
        self.compose("config", "--quiet")
        images = self.compose("config", "--images", capture=True).splitlines()
        # После первой установки все образы закреплены digest. Повторный запуск
        # использует проверенный локальный образ и не зависит от доступности registry.
        cached = bool(images) and all("@sha256:" in image and subprocess.run(
            ["docker", "image", "inspect", image], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL).returncode == 0 for image in images)
        if not cached:
            self.compose("pull")
        self.lock_images(config)
        self.compose("up", "-d", "--wait", "--wait-timeout", "300", "--remove-orphans")
        if "search" in config["modules"]:
            self.configure_search()
        self.doctor()

    def configure_search(self):
        source = self.root / "modules/prowlarr/config.xml"
        if not source.exists():
            raise RuntimeError("Prowlarr has not created config.xml; retry home-theater up after startup")
        key = ET.parse(source).getroot().findtext("ApiKey")
        if not key or not re.fullmatch(r"[a-zA-Z0-9]+", key):
            raise RuntimeError("Prowlarr API key unavailable")
        application = read_env(self.root / "application.env")
        if application.get("PROWLARR_API_KEY") != key or application.get("PROWLARR_URL") != "http://prowlarr:9696":
            application.update(PROWLARR_API_KEY=key, PROWLARR_URL="http://prowlarr:9696")
            write_env(self.root / "application.env", application)
            self.compose("up", "-d", "--wait", "--wait-timeout", "180", "application")

    def doctor(self):
        config = self.config()
        self.compose("ps")
        with urlopen(f"http://127.0.0.1:{config['httpPort']}/api/health/database", timeout=15) as response:
            if json.load(response).get("ok") is not True:
                raise RuntimeError("Database readiness failed")
        print("Database and application: ready")
        print("Enabled modules: " + (", ".join(config["modules"]) or "none"))
        if "search" not in config["modules"]:
            print("Search module not installed: torrent/magnet import remains available; aggregated tracker search is unavailable")
        if "llm" not in config["modules"]:
            print("Local LLM not installed: external metadata and saved knowledge remain available")
        print("Origin: " + config["origin"])

    def module(self, name, enabled):
        config = self.config()
        registry = json.loads((self.root / "modules.json").read_text())["modules"]
        if name not in registry or name == "https":
            raise ValueError("Use module search|llm on|off; HTTPS follows the configured origin")
        if enabled and name not in config["modules"]:
            config["modules"].append(name)
        if not enabled and name in config["modules"]:
            config["modules"].remove(name)
            # Остановка не удаляет модели, конфигурацию индексаторов или другие данные.
            self.compose("stop", *registry[name]["services"])
        self.save(config)
        self.up()

    def origin(self, value):
        config = self.config()
        origin = validate_origin(value)
        if origin.startswith("https:") and "https" not in config["modules"]:
            config["modules"].append("https")
        elif origin.startswith("http:") and "https" in config["modules"]:
            self.compose("stop", "proxy")
            config["modules"].remove("https")
        config["origin"] = origin
        self.save(config)
        self.up()


def install(args):
    check_platform()
    if not Path(args.root).is_absolute():
        raise ValueError("Installation directory must be absolute")
    root = Path(args.root).resolve()
    if root == Path("/") or not root.is_absolute():
        raise ValueError("Choose an absolute installation directory other than /")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    installation = Installation(root)
    if (root / "installation.json").exists():
        existing = installation.config()
        if args.image and args.image != existing["image"]:
            raise ValueError("Already installed with a different image; use the planned update workflow")
        if args.origin and validate_origin(args.origin) != existing["origin"]:
            raise ValueError("Existing origin is preserved; changing it requires explicit reconfiguration")
        print("Existing installation preserved; secrets, data and image unchanged")
        docker_install()
        installation.up()
        from server_backup import daily_schedule
        daily_schedule(installation)
        return
    if any(root.iterdir()):
        # Не перезаписываем чужую установку или незавершённый набор секретов.
        raise ValueError("Install directory is not empty and has no installation.json; inspect it before retrying")
    bundle = Path(args.bundle).resolve()
    image_file = bundle / "server-image.txt"
    image = args.image or (image_file.read_text().strip() if image_file.exists() else "")
    if not IMAGE.fullmatch(image):
        raise ValueError("Use a GHCR image pinned with @sha256:... from a server candidate")
    origin = validate_origin(args.origin or f"http://127.0.0.1:{args.http_port}")
    if not 1024 <= args.http_port <= 65535:
        raise ValueError("Loopback HTTP port must be between 1024 and 65535")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,40}", args.project):
        raise ValueError("Invalid Compose project name")
    modules = sorted(set(filter(None, args.modules.split(","))))
    if not set(modules) <= {"search", "llm"}:
        raise ValueError("Supported optional modules: search,llm")
    if origin.startswith("https:"):
        modules.append("https")
    required = ("compose.yml", "Caddyfile", "modules.json", "home_theater.py", "home-theater", "server_backup.py", "profiles.toml")
    for name in required:
        if not (bundle / name).is_file():
            raise ValueError(f"Incomplete installer bundle: {name}")
    docker_install()
    if shutil.disk_usage(root).free < 4 * 1024**3:
        raise RuntimeError("At least 4 GiB free space required before installation")
    for name in required:
        mode = 0o700 if name == "home-theater" else (0o644 if name == "profiles.toml" else 0o600)
        atomic(root / name, (bundle / name).read_text(), mode)
    (root / "data/stream").mkdir(mode=0o700, parents=True)
    os.chown(root / "data", 1000, 1000)
    os.chown(root / "data/stream", 1000, 1000)
    for name in ("prowlarr", "ollama"):
        (root / "modules" / name).mkdir(mode=0o700, parents=True)
        if name == "prowlarr":
            os.chown(root / "modules" / name, 1000, 1000)
    write_env(root / "server.env", {"POSTGRES_PASSWORD": secrets.token_hex(32)})
    write_env(root / "application.env", {**INTEGRATIONS, "SESSION_SECRET": secrets.token_hex(32),
                                         "TORZNAB_API_KEY": secrets.token_hex(32)})
    config = {"schemaVersion": 1, "image": image, "origin": origin,
              "httpPort": args.http_port, "project": args.project, "modules": modules}
    installation.save(config)
    installation.up()
    from server_backup import daily_schedule
    daily_schedule(installation)
    print(f"Installed. Run: sudo {root}/home-theater owner-link")
    print("Owner setup is explicit; no default public admin password or automatic registration approval")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=DEFAULT_ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("install")
    setup.add_argument("--root", default=DEFAULT_ROOT)
    setup.add_argument("--bundle", default=str(Path(__file__).resolve().parent))
    setup.add_argument("--image")
    setup.add_argument("--origin")
    setup.add_argument("--modules", default="")
    setup.add_argument("--http-port", type=int, default=5056)
    setup.add_argument("--project", default="home-theater")
    commands.add_parser("up")
    commands.add_parser("doctor")
    commands.add_parser("owner-link")
    backup = commands.add_parser("backup")
    backup.add_argument("--reason", choices=["manual", "pre-update", "daily"], default="manual")
    commands.add_parser("daily-backup-install")
    daily = commands.add_parser("daily-backup")
    daily.add_argument("state", choices=["on", "off"])
    restore = commands.add_parser("restore")
    restore.add_argument("archive")
    verify = commands.add_parser("verify-backup")
    verify.add_argument("archive")
    origin = commands.add_parser("origin")
    origin.add_argument("value")
    reset = commands.add_parser("reset-password")
    reset.add_argument("--user-id", type=int, required=True)
    module = commands.add_parser("module")
    module.add_argument("name", choices=["search", "llm"])
    module.add_argument("state", choices=["on", "off"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Run with sudo; installation contains private credentials")
    # Один управляющий процесс для установки, смены модулей и выдачи ссылок.
    lock = Path("/run/lock/home-theater-" + __import__("hashlib").sha256(str(Path(args.root).resolve()).encode()).hexdigest()[:16])
    with lock.open("w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command == "install":
            install(args)
            return
        installation = Installation(args.root)
        if args.command == "up":
            installation.up()
        elif args.command == "doctor":
            installation.doctor()
        elif args.command == "module":
            installation.module(args.name, args.state == "on")
        elif args.command == "origin":
            installation.origin(args.value)
        elif args.command == "backup":
            from server_backup import create_backup
            create_backup(installation, args.reason)
        elif args.command == "restore":
            from server_backup import restore_backup
            restore_backup(installation, args.archive)
        elif args.command == "verify-backup":
            from server_backup import verify_backup
            verify_backup(args.archive)
            print("Backup checksums verified")
        elif args.command in ("daily-backup", "daily-backup-install"):
            from server_backup import daily_schedule
            daily_schedule(installation, None if args.command == "daily-backup-install" else args.state == "on")
        elif args.command in ("owner-link", "reset-password"):
            command = "create-owner" if args.command == "owner-link" else "reset"
            extra = [] if command == "create-owner" else ["--user-id", str(args.user_id)]
            installation.compose("exec", "-T", "application", "node", "database/account-admin.mjs", command, *extra)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"home-theater: {error}", file=sys.stderr)
        sys.exit(1)
