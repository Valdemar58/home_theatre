#!/usr/bin/env bash
# Запуск из распакованного серверного пакета; скачанный код не исполняется через curl | sh.
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$task_root/deploy/server/home_theater.py" install --bundle "$task_root/deploy/server" "$@"
