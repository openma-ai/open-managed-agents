"""Template-prestarted management launcher. No shell, stdio bridge or Work logic.
The directory and this file must be owned by root and inaccessible to agents.
Only the provider Files API (user=root) may submit management requests.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/run/oma-managed")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
os.umask(0o077)
children = {}
# Management is trusted root; agent processes MUST use agent-spawner.mjs.
# WNOWAIT retains the exited leader PID, pinning its PGID until group cleanup.
if not hasattr(os, "waitid") or os.getuid() != 0:
    raise RuntimeError("Native management requires Linux root and waitid/WNOWAIT")
cleaned = set()
stopping = False

def stop(_signal, _frame):
    global stopping
    stopping = True

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def text(value):
    return isinstance(value, str) and "\0" not in value

def dispatch(request):
    op = request.get("op")
    if op == "start":
        if request["id"] in children:
            raise ValueError("duplicate managed start")
        if len(children) >= 128:
            raise ValueError("management capacity exhausted; recycle sandbox")
        spec = request["spec"]
        command, args, env = spec["command"], spec.get("args", []), spec["env"]
        if not text(command) or not command.startswith("/") or not isinstance(args, list) or not all(text(a) for a in args):
            raise ValueError("absolute command and literal argv required")
        if not isinstance(env, dict) or not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) and text(v) for k, v in env.items()):
            raise ValueError("invalid replacement environment")
        cwd = spec.get("cwd")
        if cwd is not None and (not text(cwd) or not cwd.startswith("/")):
            raise ValueError("absolute cwd required")
        # shell=False and explicit env replace the environment BEFORE execve.
        # No pipes: the worker communicates directly with its control plane.
        child = subprocess.Popen([command] + args, env=env, cwd=cwd or "/workspace",
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        children[request["id"]] = child
        return {"id": request["id"], "pid": child.pid}
    child = children[request["target"]]
    status = request["target"] in cleaned or os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    if op == "kill":
        sig = request["signal"]
        if sig not in ("SIGTERM", "SIGKILL"):
            raise ValueError("invalid signal")
        if request["target"] not in cleaned:
            # Leader is unreaped even after exit: the PGID cannot be recycled.
            try:
                os.killpg(child.pid, getattr(signal, sig))
            except ProcessLookupError:
                pass
            if sig == "SIGTERM":
                # Keep the leader unreaped through escalation: descendants may
                # ignore TERM even when the leader has already exited.
                time.sleep(0.1)
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.wait()
            cleaned.add(request["target"])
        return {}
    if op == "status":
        return {"status": "exited" if status else "running"}
    raise ValueError("unknown operation")

(root / "ready").write_text("oma-managed-v2")
try:
    while not stopping:
        for trigger in root.glob("*.go"):
            ident = trigger.stem
            if not re.fullmatch(r"[a-f0-9-]{36}", ident):
                continue
            source = root / (ident + ".json")
            request = {}
            try:
                request = json.loads(source.read_text())
                if request.get("id") != ident:
                    raise ValueError("invalid request id")
                result = {"ok": True, **dispatch(request)}
            except Exception as error:
                # Do not return command/env or native error text containing secrets.
                result = {"ok": False, "error": "native spawn failed" if request.get("op") == "start" else "management request failed"}
            finally:
                source.unlink(missing_ok=True)
                trigger.unlink(missing_ok=True)
            output = root / (ident + ".response.json")
            temporary = root / (ident + ".tmp")
            temporary.write_text(json.dumps(result))
            temporary.replace(output)
        # Replies contain no launch environment. Bound their disk lifetime.
        now = time.time()
        for reply in root.glob("*.response.json"):
            if now - reply.stat().st_mtime > 60:
                reply.unlink(missing_ok=True)
        time.sleep(0.02)
finally:
    (root / "ready").unlink(missing_ok=True)
    for ident, child in children.items():
        if ident in cleaned:
            continue
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for child in children.values():
        child.wait()
