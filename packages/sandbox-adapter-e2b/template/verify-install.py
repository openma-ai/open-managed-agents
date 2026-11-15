"""Fail closed if the template's trusted installation is incomplete or writable.
Root-prefix argument exists for disposable installation tests, not runtime routing.
"""
import hashlib
import json
import os
import sys
import stat
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source-sha", required=True)
parser.add_argument("--lock-sha256", required=True)
parser.add_argument("root", nargs="?", default="/")
args = parser.parse_args()
if not re.fullmatch("[a-f0-9]{40}", args.source_sha) or not re.fullmatch("[a-f0-9]{64}", args.lock_sha256):
    raise ValueError("explicit full source pin required")
base = Path(args.root).resolve()
managed = base / "opt/oma-managed"
# The base template installs no ACP agent (Environment setup does).
installed = []

def trusted(path):
    # Walk lexical components BEFORE following links; recursively inspect every
    # link destination too. A safe resolved leaf cannot hide a mutable alias.
    def walk(path, depth=0):
        if depth > 40:
            raise ValueError("symlink chain too deep")
        path = Path(path)
        if not path.is_absolute():
            raise ValueError("absolute trusted path required")
        if path != base / "opt" and base / "opt" not in path.parents:
            raise ValueError("trusted installation escaped /opt")
        current = base
        for component in path.relative_to(base).parts:
            if component == "..":
                current = current.parent
                if current != base / "opt" and base / "opt" not in current.parents:
                    raise ValueError("symlink traversal escaped /opt")
                continue
            current = current / component
            info = current.lstat()
            if info.st_uid != 0 or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o022):
                raise ValueError("trusted installation is not root-owned and write-protected")
            if stat.S_ISLNK(info.st_mode):
                target = Path(os.readlink(current))
                current = walk(target if target.is_absolute() else current.parent / target, depth + 1)
        return current
    return walk(path)

manifest = json.loads(trusted(managed / "installation.json").read_text())
if manifest.get("sourceSha") != args.source_sha or manifest.get("sourceLockSha256") != args.lock_sha256 or manifest.get("common") != "0.14.0":
    raise ValueError("untrusted worker source or common version")
if manifest.get("command") != "/usr/local/bin/node" or manifest.get("args") != ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]:
    raise ValueError("unexpected worker command")
if manifest.get("harnesses") != installed:
    raise ValueError("unexpected installed harness")
for name in ["launcher.py", "agent-spawner.mjs", "agent-exec.py", "verify-install.py", "worker/node-e2b-work-item-cli.js", "worker/bundle-meta.json"]:
    path = trusted(managed / name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["files"][name]:
        raise ValueError("trusted installation digest mismatch")
for path in managed.rglob("*"):
    trusted(path)
if (base / "opt/oma-harnesses").exists():
    raise ValueError("base template must not carry a preinstalled ACP harness")
# No worker runtime node_modules: bundle contains official common, external=Node builtins.
if (managed / "worker/node_modules").exists():
    raise ValueError("unexpected worker dependency directory")
print("oma-managed-install-v2")
