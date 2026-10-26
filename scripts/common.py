"""Общие утилиты для скриптов: корень проекта, чтение .env, пути."""
import sys
from pathlib import Path

# Кириллица в консоли Windows и при перенаправлении вывода
for _stream in (sys.stdout, sys.stderr):
    _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"


def parse_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env[key.strip()] = value
    return env


def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        raise SystemExit("Нет .env — сначала запусти: python scripts/init.py")
    return parse_env(ENV_FILE)


def resolve(path: str) -> Path:
    """Путь из .env: относительные считаются от корня проекта (как в docker compose)."""
    p = Path(path).expanduser()
    return p if p.is_absolute() else (ROOT / p).resolve()
