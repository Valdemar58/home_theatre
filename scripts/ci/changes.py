"""Classify a Git diff. Unknown/shared changes deliberately run every check."""
import os
import subprocess
import sys


def classify(paths):
    server = desktop = database = False
    for path in paths:
        if path.startswith(("docs/", ".github/ISSUE_TEMPLATE/")) or path in (
            "README.md", "PRODUCT.md", "DESIGN.md", ".github/pull_request_template.md"
        ):
            continue
        if path.startswith("apps/desktop/"):
            desktop = True
        elif path.startswith("apps/anime-calendar/"):
            server = True
            if path.startswith(tuple("apps/anime-calendar/" + p for p in (
                "database/", "migrations/", "src/server/", "src/app/api/"
            ))) or path.endswith(("package.json", "package-lock.json", "vitest.config.mts")):
                database = True
        else:
            server = desktop = database = True
    return {"server": server, "desktop": desktop, "database": database}


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else ""
    if not base or set(base) == {"0"}:
        result = dict.fromkeys(("server", "desktop", "database"), True)
    else:
        paths = subprocess.check_output(
            ["git", "diff", "--name-only", "-z", base, "HEAD"]
        ).decode().split("\0")
        result = classify([p for p in paths if p])
    output = "".join(f"{k}={str(v).lower()}\n" for k, v in result.items())
    print(output, end="")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(output)
