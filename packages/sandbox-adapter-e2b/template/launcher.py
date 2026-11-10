"""Template-prestarted management launcher. No shell, stdio bridge or Work logic.
The directory and this file must be owned by root and inaccessible to agents.
Only the provider Files API (user=root) may submit management requests.
"""
import hashlib
import zlib
import json
import fcntl
import stat
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/run/oma-managed")
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
os.umask(0o077)
children = {}
identities = {}
# Immutable launch binding alongside existing child/identity, never a Work ledger.
holders = {}
epoch = str(uuid.uuid4())
slot = None
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

def holder_binding(token, sandbox_id):
    # Same digest contract as sandboxTokenSha256: hash the 43-char random part,
    # not the prefix/checksum. The root-only request supplies the provider ID.
    if not isinstance(token, str) or not isinstance(sandbox_id, str) or not sandbox_id:
        return None
    match = re.fullmatch(r"oma_sbx_([0-9A-Za-z]{43})([0-9A-Za-z]{6})", token)
    if not match:
        return None
    value = zlib.crc32(("oma_sbx_" + match[1]).encode())
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    checksum = ""
    for _ in range(6):
        checksum = alphabet[value % 62] + checksum
        value //= 62
    if checksum != match[2]:
        return None
    return {"sandboxId": sandbox_id, "holderHash": hashlib.sha256(match[1].encode()).hexdigest()}

def dispatch(request):
    global slot
    op = request.get("op")
    if op == "inspect-slot":
        if slot is None:
            raise ValueError("no trustworthy management locator")
        child = children[slot]
        status = slot in cleaned or os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        if identities[slot] is None:
            raise ValueError("management identity unavailable")
        return {"locator": {"id": slot, "epoch": epoch, "pid": child.pid, "identity": identities[slot], "status": "exited" if status else "running", **(holders.get(slot) or {})}}
    if op == "start":
        if request["id"] in children:
            raise ValueError("duplicate managed start")
        if len(children) >= 128:
            raise ValueError("management capacity exhausted; recycle sandbox")
        identity = request.get("identity")
        if identity is not None and (not isinstance(identity, dict) or set(identity) != {"workspaceId", "sessionId", "workId", "attemptId"} or not all(text(value) and 0 < len(value) <= 256 for value in identity.values())):
            raise ValueError("invalid management identity")
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
        # Stable sandbox-local inode; never unlink or name by Work/attempt.
        lock_path = root / "worker.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
                raise ValueError("unsafe management lock")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("management worker busy") from None
            # pass_fds clears CLOEXEC for exactly this fd in the actual worker.
            # The launcher closes its duplicate immediately, not on worker exit.
            child = subprocess.Popen([command] + args, env=env, cwd=cwd or "/workspace",
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, start_new_session=True,
                                     pass_fds=(descriptor,))
        finally:
            os.close(descriptor)
        children[request["id"]] = child
        identities[request["id"]] = identity
        holders[request["id"]] = holder_binding(env.get("OPENMA_SANDBOX_TOKEN"), request.get("sandboxId"))
        slot = request["id"]
        return {"id": request["id"], "pid": child.pid, "epoch": epoch}
    child = children[request["target"]]
    expected = identities[request["target"]]
    # Recovery is never authenticated by caller-supplied fields alone. Legacy
    # local handles omit identity; any bound/recovery request needs stored identity.
    if expected is None and (request.get("requireBound") is True or request.get("identity") is not None):
        raise ValueError("management target has no bound identity")
    if request.get("epoch") is not None and request.get("epoch") != epoch:
        raise ValueError("management locator epoch mismatch")
    if expected is not None and (request.get("identity") != expected or request.get("epoch") != epoch):
        raise ValueError("management locator identity mismatch")
    if "holderHash" in request or "sandboxId" in request:
        binding = holders.get(request["target"])
        if not binding or request.get("holderHash") != binding["holderHash"] or request.get("sandboxId") != binding["sandboxId"]:
            raise ValueError("management holder binding mismatch")
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
                result = {"ok": False, "error": "management worker busy" if isinstance(error, RuntimeError) and str(error) == "management worker busy" else "native spawn failed" if request.get("op") == "start" else "management request failed"}
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
