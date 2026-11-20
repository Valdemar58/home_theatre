#!/usr/bin/env python3
"""Собрать переносимый пакет установщика с конкретным digest образа."""
import argparse
import hashlib
import io
from pathlib import Path
import re
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
if not re.fullmatch(r"ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}", args.image):
    parser.error("Expected immutable GHCR image digest")
root = Path(__file__).resolve().parents[1]
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
with tarfile.open(output, "w:gz") as archive:
    for source in sorted((root / "deploy/server").iterdir()):
        if source.is_file() and source.suffix != ".pyc":
            archive.add(source, arcname="deploy/server/" + source.name)
    archive.add(root / "profiles.toml", arcname="deploy/server/profiles.toml")
    archive.add(root / "scripts/install.sh", arcname="scripts/install.sh")
    for name, content in (("server-image.txt", args.image), ("source-commit.txt", commit)):
        data = (content + "\n").encode()
        info = tarfile.TarInfo("deploy/server/" + name)
        info.size, info.mode = len(data), 0o644
        archive.addfile(info, io.BytesIO(data))
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_name(output.name + ".sha256").write_text(f"{checksum}  {output.name}\n")
print(f"Server installer packaged for commit {commit}")
