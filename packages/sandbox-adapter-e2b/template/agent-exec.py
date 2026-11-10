"""Root-private native identity boundary for common's local NodeSpawner.
Not setuid; ordinary agents cannot use this to acquire privilege.
"""
import ctypes
import errno
import json
import os
import pwd
import sys

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
# Irreversible privilege loss, including privilege gained by a later exec.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
    raise OSError(ctypes.get_errno(), "cannot set no_new_privs")
for capability in range(64):
    if libc.prctl(24, capability, 0, 0, 0) != 0 and ctypes.get_errno() != errno.EINVAL:  # PR_CAPBSET_DROP
        raise OSError(ctypes.get_errno(), "cannot drop capability bounding set")
os.setgroups([])
os.setresgid(agent.pw_gid, agent.pw_gid, agent.pw_gid)
os.setresuid(agent.pw_uid, agent.pw_uid, agent.pw_uid)
# setresuid resets dumpability before exec; no agent-readable process ever
# carries the worker's inherited environment. The target receives only spec.env.
os.execvpe(spec["command"], [spec["command"]] + spec.get("args", []), spec["env"])
