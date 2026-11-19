#!/usr/bin/env bash
# Read-only package preflight. Does not install dependencies or weaken Chromium sandboxing.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "Usage: bash check-arch-package.sh /path/to/package.AppImage EXPECTED_SHA256" >&2
  exit 2
fi
package=$(realpath -- "$1")
expected=$2
[[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Invalid SHA256" >&2; exit 2; }
[[ $(uname -m) == x86_64 ]] || { echo "This package requires x86_64" >&2; exit 1; }
printf '%s  %s\n' "$expected" "$package" | sha256sum --check --status
echo "SHA256 verified"
cat /etc/os-release
printf 'Session: %s; display: %s; Wayland: %s\n' "${XDG_SESSION_TYPE:-unset}" "${DISPLAY:-unset}" "${WAYLAND_DISPLAY:-unset}"
[[ -x $package ]] || { echo "Executable permission is missing. Run chmod +x on the package, then repeat." >&2; exit 1; }
"$package" --appimage-version
echo "Package preflight passed. This does NOT verify GUI, sandbox, keyring, playback or updates."
echo "Continue with docs/watch-together-m8-acceptance.md. Do not launch with --no-sandbox."
