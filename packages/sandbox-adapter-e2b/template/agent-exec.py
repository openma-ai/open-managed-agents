"""Guest management native default-identity launcher for common's local NodeSpawner.
Not setuid. Guest sudo is intentionally available; UID separation is not a
security boundary against the guest user. Provider isolation remains external.
"""
import ctypes
import json
import os
import pwd
import sys
import subprocess

if os.getuid() != 0:
    raise SystemExit("trusted worker identity required")
with open(sys.argv[1]) as source:
    spec = json.load(source)
os.unlink(sys.argv[1])
# Defense in depth: only local ACP stdio crosses the identity boundary.
# Never let an agent extend management flock ownership via inherited extras.
os.closerange(3, os.sysconf("SC_OPEN_MAX"))
agent = pwd.getpwnam("oma-worker")
if agent.pw_uid == 0 or agent.pw_gid == 0:
    raise SystemExit("unprivileged agent identity required")
# NNP is inherited and irreversible. Fail explicitly rather than advertise
# functional sudo in a provider/container that has disabled setuid execution.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(39, 0, 0, 0, 0) != 0:  # PR_GET_NO_NEW_PRIVS
    raise SystemExit("Guest sudo unavailable: inherited no_new_privs")
for capability in (6, 7):  # CAP_SETGID / CAP_SETUID required by sudo
    if libc.prctl(23, capability, 0, 0, 0) != 1:  # PR_CAPBSET_READ
        raise SystemExit("Guest sudo unavailable: inherited capability bounding set")
# Retain the provider's bounding set; never add host capabilities or remove
# outer seccomp filters. setresuid clears effective/permitted/ambient caps.
os.setgroups([])
os.setresgid(agent.pw_gid, agent.pw_gid, agent.pw_gid)
os.setresuid(agent.pw_uid, agent.pw_uid, agent.pw_uid)
# Verify the real setuid sudo path after dropping identity. This also rejects
# nosuid mounts, missing sudoers, restrictive bounding sets and outer seccomp.
probe = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/id", "-u"],
    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": agent.pw_dir},
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, timeout=10)
if probe.returncode != 0 or probe.stdout.strip() != "0":
    raise SystemExit("Guest sudo unavailable after ordinary identity selection")
# setresuid resets dumpability before exec; no agent-readable process ever
# carries the worker's inherited environment. The target receives only spec.env.
os.execvpe(spec["command"], [spec["command"]] + spec.get("args", []), spec["env"])
