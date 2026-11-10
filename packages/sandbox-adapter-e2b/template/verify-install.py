"""Fail closed if the template's trusted installation is incomplete or writable.
Root-prefix argument exists for disposable installation tests, not runtime routing.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

base = Path(sys.argv[1] if len(sys.argv) > 1 else "/").resolve()
managed = base / "opt/oma-managed"
harness = base / "opt/oma-harnesses/codex-acp"

def trusted(path):
    # Resolve package-manager symlinks, but never permit links outside /opt.
    actual = path.resolve(strict=True)
    if base / "opt" not in actual.parents:
        raise ValueError("trusted installation escaped /opt")
    current = actual
    while current != base:
        info = current.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("trusted installation is not root-owned and write-protected")
        current = current.parent
    return actual

manifest = json.loads(trusted(managed / "installation.json").read_text())
if manifest.get("sourceSha") != "5e1b0e0edbbba72dae4bce4531da4c46bbf978fa" or manifest.get("common") != "0.13.1":
    raise ValueError("untrusted worker source or common version")
if manifest.get("command") != "/usr/local/bin/node" or manifest.get("args") != ["/opt/oma-managed/worker/node-e2b-work-item-cli.js"]:
    raise ValueError("unexpected worker command")
if manifest.get("harness") != {"id": "codex-acp", "version": "1.8.0", "command": "/opt/oma-harnesses/codex-acp/bin/codex-acp"}:
    raise ValueError("unexpected installed harness")
for name in ["launcher.py", "agent-spawner.mjs", "agent-exec.py", "verify-install.py", "worker/node-e2b-work-item-cli.js", "worker/bundle-meta.json"]:
    path = trusted(managed / name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["files"][name]:
        raise ValueError("trusted installation digest mismatch")
for name in ["package.json", "package-lock.json"]:
    path = trusted(harness / name)
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["files"]["harness/" + name]:
        raise ValueError("installed harness lock mismatch")
for tree in [managed, harness]:
    for path in tree.rglob("*"):
        trusted(path)
package = json.loads((harness / "node_modules/@agentclientprotocol/codex-acp/package.json").read_text())
if package["version"] != "1.8.0":
    raise ValueError("installed harness version mismatch")
command = trusted(harness / "bin/codex-acp")
if not os.access(command, os.X_OK):
    raise ValueError("installed harness command is not executable")
# No worker runtime node_modules: bundle contains official common, external=Node builtins.
if (managed / "worker/node_modules").exists():
    raise ValueError("unexpected worker dependency directory")
print("oma-managed-install-v2")
