"""Плановое окно обновления: подготовка, quiescence, копия, запуск и откат."""
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
from urllib.request import urlopen

from server_backup import create_backup, restore_backup

OPS_FILES = ("compose.yml", "Caddyfile", "profiles.toml", "modules.json", "home_theater.py",
             "home-theater", "server_backup.py", "server_update.py")


def api(installation):
    with urlopen(f"http://127.0.0.1:{installation.config()['httpPort']}/api/maintenance", timeout=5) as response:
        value = json.load(response)
    if value.get("protocol") != 1:
        raise ValueError("Server does not support maintenance protocol 1; bootstrap in an explicit maintenance window first")
    return value


def unit_name(installation):
    return "home-theater-update-" + hashlib.sha256(str(installation.root).encode()).hexdigest()[:12]


def scheduled_at(value):
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("Specify time with a timezone, e.g. 2026-11-20T20:00:00+01:00")
    # systemd OnCalendar is written at whole-second precision. Never allow its
    # timer to run before a fractional start recorded in the coordination file.
    return datetime.fromtimestamp(math.ceil(timestamp.timestamp()), timezone.utc)


def control(installation, plan):
    from home_theater import write_json
    target = installation.root / "data/maintenance.json"
    if plan is None:
        target.unlink(missing_ok=True)
    else:
        write_json(target, {key: plan[key] for key in ("id", "label", "startsAt", "endsAt")})
        os.chmod(target, 0o644)


def schedule(installation, bundle, at, minutes):
    from home_theater import IMAGE, atomic, write_json
    if not 1 <= minutes <= 120:
        raise ValueError("Maintenance window must be 1–120 minutes")
    timestamp = scheduled_at(at)
    start = int(timestamp.timestamp() * 1000)
    if start <= time.time() * 1000 + 5000:
        raise ValueError("Choose a future maintenance window")
    if (installation.root / "update-plan.json").exists():
        raise ValueError("An update is already scheduled; cancel it explicitly first")
    api(installation)
    source = Path(bundle).resolve()
    image = (source / "server-image.txt").read_text().strip()
    if not IMAGE.fullmatch(image):
        raise ValueError("Candidate must specify an immutable GHCR image")
    if not all((source / name).is_file() and not (source / name).is_symlink() for name in OPS_FILES):
        raise ValueError("Incomplete update bundle")
    root = str(installation.root)
    if not re.fullmatch(r"/[a-zA-Z0-9_/.-]+", root):
        raise ValueError("Update schedule requires a simple absolute installation path")
    # Pull before the countdown: a failed/slow registry does not interrupt playback.
    subprocess.run(["docker", "pull", image], check=True)
    if start <= time.time() * 1000 + 5000:
        raise ValueError("Image preparation exceeded the chosen start time; choose a new window")
    ident = secrets.token_hex(12)
    stage = installation.root / "updates" / ident
    stage.mkdir(parents=True, mode=0o700)
    checksums = {}
    for name in OPS_FILES:
        shutil.copyfile(source / name, stage / name)
        os.chmod(stage / name, 0o700 if name == "home-theater" else 0o600)
        checksums[name] = hashlib.sha256((stage / name).read_bytes()).hexdigest()
    label = (source / "source-commit.txt").read_text().strip()[:12]
    if not re.fullmatch(r"[a-f0-9]{7,12}", label):
        raise ValueError("Candidate source commit missing or invalid")
    plan = {"id": ident, "label": label, "image": image, "startsAt": start,
            "endsAt": start + minutes * 60000, "checksums": checksums}
    write_json(installation.root / "update-plan.json", plan)
    unit = unit_name(installation)
    directory = Path("/etc/systemd/system")
    atomic(directory / (unit + ".service"), "[Unit]\nDescription=home_theater scheduled update\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nType=oneshot\nUMask=0077\n"
           f"ExecStart={root}/home-theater --root {root} update-run {ident}\nTimeoutStartSec=3h\n", 0o644)
    calendar = timestamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    atomic(directory / (unit + ".timer"), f"[Unit]\nDescription=home_theater maintenance window\n\n[Timer]\nOnCalendar={calendar}\nPersistent=true\nUnit={unit}.service\n\n[Install]\nWantedBy=timers.target\n", 0o644)
    try:
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        control(installation, plan)
        subprocess.run(["systemctl", "enable", "--now", unit + ".timer"], check=True)
    except Exception:
        control(installation, None)
        (installation.root / "update-plan.json").unlink(missing_ok=True)
        subprocess.run(["systemctl", "disable", "--now", unit + ".timer"], check=False)
        raise
    print("Update scheduled: " + calendar + "; source " + label)


def cancel(installation):
    subprocess.run(["systemctl", "disable", "--now", unit_name(installation) + ".timer"], check=False)
    control(installation, None)
    (installation.root / "update-plan.json").unlink(missing_ok=True)
    print("Scheduled update cancelled; paused playback requires an explicit resume")


def wait_ready(installation, plan):
    while time.time() * 1000 < plan["endsAt"]:
        try:
            status = json.loads((installation.root / "data/maintenance-ack.json").read_text())
            age = time.time() * 1000 - status["observedAt"]
            if status["id"] == plan["id"] and status["ready"] is True and 0 <= age < 5000:
                return
        except (FileNotFoundError, KeyError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Maintenance window expired before rooms and server tasks stopped safely; update cancelled")


def execute(installation, ident):
    from home_theater import atomic
    plan = json.loads((installation.root / "update-plan.json").read_text())
    if ident != plan["id"] or not re.fullmatch(r"[a-f0-9]{24}", ident):
        raise ValueError("Stale update timer; nothing changed")
    if time.time() * 1000 < plan["startsAt"]:
        raise ValueError("Maintenance window has not started")
    original = installation.config()
    before = {name: (installation.root / name).read_bytes() for name in OPS_FILES}
    backup = None
    stage = installation.root / "updates" / ident
    changed = False
    recovered = False
    try:
        for name in OPS_FILES:
            if hashlib.sha256((stage / name).read_bytes()).hexdigest() != plan["checksums"][name]:
                raise ValueError("Prepared update checksum mismatch")
        wait_ready(installation, plan)
        backup = create_backup(installation, "pre-update", allow_active=True)
        if time.time() * 1000 >= plan["endsAt"]:
            raise RuntimeError("Backup exceeded maintenance window; update cancelled")
        changed = True
        installation.compose("stop", "--timeout", "60", "application")
        for name in OPS_FILES:
            atomic(installation.root / name, (stage / name).read_text(), 0o700 if name == "home-theater" else 0o644 if name == "profiles.toml" else 0o600)
        installation.save({**original, "image": plan["image"]})
        installation.up()
        api(installation)
        recovered = True
        print("Update ready; rooms remain paused at their saved position")
    except Exception:
        if changed and backup:
            for name, content in before.items():
                atomic(installation.root / name, content.decode(), 0o700 if name == "home-theater" else 0o644 if name == "profiles.toml" else 0o600)
            installation.save(original)
            installation.render(original)
            restore_backup(installation, backup, allow_active=True, safety_backup=False)
            recovered = True
            print("Update failed; previous image and data restored")
        elif not changed:
            # No migrations ran; the original instance and its data are retained.
            installation.up()
            recovered = True
        raise
    finally:
        if recovered:
            cancel(installation)
        else:
            print("Automatic recovery failed; maintenance remains active. Original backup retained.")
