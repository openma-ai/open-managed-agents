"""Real process FD/flock acceptance in disposable Linux root container."""
import fcntl
import json
import os
import pwd
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

source = Path('/source/template')
base = Path(tempfile.mkdtemp(prefix='flock-', dir='/workspace'))
daemons = []
pids = []

def wait(check):
    for _ in range(300):
        try:
            result = check()
            if result:
                return result
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(.01)
    raise AssertionError('bounded observation timed out')

def daemon(directory):
    directory.mkdir()
    child = subprocess.Popen(['/usr/bin/python3','-I','-S',str(source/'launcher.py'),str(directory)])
    daemons.append(child)
    wait(lambda:(directory/'ready').exists())
    return child

def request(directory, body):
    ident = str(uuid.uuid4())
    (directory/(ident+'.json')).write_text(json.dumps({'id':ident,**body}))
    (directory/(ident+'.go')).touch()
    return wait(lambda:json.loads((directory/(ident+'.response.json')).read_text()))

def start(directory, work, code='setInterval(()=>{},1000)'):
    result = request(directory, {'op':'start','spec':{'command':'/usr/local/bin/node','args':['-e',code], 'env':{'ANTHROPIC_WORK_ID':work},'cwd':'/workspace'}})
    if result.get('pid'):
        pids.append(result['pid'])
    return result

def fd_targets(pid):
    result = []
    for fd in Path('/proc/%s/fd'%pid).iterdir():
        try:
            result.append(os.readlink(fd))
        except FileNotFoundError:
            pass
    return result

try:
    one = base/'sandbox-one'; launcher = daemon(one)
    first = start(one,'work-old-attempt')
    assert first['ok'], first
    lock = one/'worker.lock'
    assert lock.exists(), 'worker lock missing'
    inode = lock.stat().st_ino
    assert str(lock) in fd_targets(first['pid']), 'actual Node worker does not hold inherited FD'
    assert str(lock) not in fd_targets(launcher.pid), 'launcher retained duplicate lock FD'
    assert lock.stat().st_uid == 0 and lock.stat().st_mode & 0o077 == 0
    marker = base/'busy-command-executed'
    busy = start(one,'work-new-attempt',"require('fs').writeFileSync("+json.dumps(str(marker))+",'unsafe')")
    assert not busy['ok'] and 'busy' in busy['error'].lower(), busy
    assert not marker.exists(), 'busy command executed'
    # Another physical sandbox has an independent inode and worker.
    two = base/'sandbox-two'; daemon(two)
    other = start(two,'independent-work')
    assert other['ok'] and (two/'worker.lock').stat().st_ino != inode
    # SIGKILL releases the kernel lock even before the leader is reaped.
    os.kill(first['pid'],signal.SIGKILL)
    next_worker = wait(lambda: (r if (r:=start(one,'replacement-work'))['ok'] else None))
    assert lock.stat().st_ino == inode, 'stable lock inode replaced'
    assert str(lock) in fd_targets(next_worker['pid'])
    # Existing handle remains registered; explicit kill must not disturb successor.
    assert request(one,{'op':'kill','target':first['id'],'signal':'SIGKILL'})['ok']
    os.kill(next_worker['pid'],0)
    assert request(one,{'op':'kill','target':next_worker['id'],'signal':'SIGKILL'})['ok']
    # Actual published common NodeSpawner must not propagate the management fd.
    Path('/run/oma-managed').mkdir(mode=0o700,parents=True,exist_ok=True)
    script = base/'fd-worker.mjs'
    agent_output = base/'agent-fds.json'
    agent_ready = base/'agent-ready'
    base.chmod(0o777)
    agent_code = "const fs=require('fs');fs.writeFileSync("+json.dumps(str(agent_output))+",JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return [fs.readlinkSync('/proc/self/fd/'+fd)]}catch{return []}})));fs.writeFileSync("+json.dumps(str(agent_ready))+",String(process.pid));setInterval(()=>{},1000)"
    script.write_text("import {NodeSpawner} from 'file:///common/dist/acp-runtime/spawners/node.js';\nimport {isolateE2BAgentSpawner} from 'file:///source/template/agent-spawner.mjs';\nconst child=await isolateE2BAgentSpawner(new NodeSpawner()).spawn({command:'/usr/local/bin/node',args:['-e',"+json.dumps(agent_code)+"],env:{}});setInterval(()=>{},1000);")
    managed = request(one,{'op':'start','spec':{'command':'/usr/local/bin/node','args':[str(script)],'env':{},'cwd':'/workspace'}})
    assert managed['ok'], managed
    pids.append(managed['pid'])
    agent_pid = int(wait(lambda:agent_ready.read_text()))
    pids.append(agent_pid)
    targets = json.loads(agent_output.read_text())
    assert str(lock) not in targets, 'agent inherited management fd'
    assert str(lock) in fd_targets(managed['pid']), 'parent Node worker lost lock'
    os.kill(managed['pid'],signal.SIGKILL)
    takeover = wait(lambda:(r if (r:=start(one,'after-parent-death'))['ok'] else None))
    assert takeover['ok'], 'agent extended lock after worker died'
    # Force an inherited locked fd into helper independently of NodeSpawner's
    # own stdio close behavior; helper must explicitly discard it before agent exec.
    forced_lock = base/'forced.lock'
    descriptor = os.open(forced_lock,os.O_CREAT|os.O_RDWR,0o600)
    fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
    forced_output = base/'forced-agent-fds.json'
    forced_spec = base/'forced-spec.json'
    forced_code = "const fs=require('fs');fs.writeFileSync("+json.dumps(str(forced_output))+",JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return [fs.readlinkSync('/proc/self/fd/'+fd)]}catch{return []}})));setInterval(()=>{},1000)"
    forced_spec.write_text(json.dumps({'command':'/usr/local/bin/node','args':['-e',forced_code],'env':{}}));forced_spec.chmod(0o600)
    forced = subprocess.Popen(['/usr/bin/python3','-I','-S',str(source/'agent-exec.py'),str(forced_spec)],pass_fds=(descriptor,))
    pids.append(forced.pid)
    os.close(descriptor)
    wait(lambda:forced_output.exists())
    assert str(forced_lock) not in json.loads(forced_output.read_text()), 'helper leaked forced fd'
    check = os.open(forced_lock,os.O_RDWR)
    fcntl.flock(check,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(check)
    forced.kill();forced.wait(timeout=5)
    agent = pwd.getpwnam('oma-worker')
    probe = "import os,sys; p=sys.argv[1]; assert not os.access(p,os.R_OK); assert not os.access(os.path.dirname(p),os.W_OK)"
    subprocess.run(['/usr/bin/python3','-I','-S','-c',probe,str(lock)], user=agent.pw_uid,group=agent.pw_gid,extra_groups=[],check=True)
    print(json.dumps({'nodeWorkerHoldsFd':True,'launcherNoDuplicateFd':True,'differentAttemptBusyZeroExecution':True,'sigkillSameSandboxTakeover':True,'stablePrivateInode':True,'differentSandboxIndependent':True}))
finally:
    for child in daemons:
        if child.poll() is None:
            child.terminate();child.wait(timeout=5)
    for pid in pids:
        try: os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError: pass
