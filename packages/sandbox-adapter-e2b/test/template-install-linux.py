"""Local disposable Linux installation acceptance; no cloud and no real credentials."""
import json
import os
import pwd
import shutil
import subprocess
from pathlib import Path

context = Path('/context')
managed = Path('/opt/oma-managed')
harness = Path('/opt/oma-harnesses/codex-acp')
managed.mkdir(parents=True, mode=0o700)
harness.mkdir(parents=True)
for name in ['launcher.py', 'agent-spawner.mjs', 'agent-exec.py', 'verify-install.py', 'installation.json']:
    shutil.copy(context / name, managed / name)
    (managed / name).chmod(0o600)
shutil.copytree(context / 'worker', managed / 'worker')
shutil.copytree(context / 'harness', harness, dirs_exist_ok=True)
subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=harness, check=True)
(harness / 'bin').mkdir()
(harness / 'bin/codex-acp').symlink_to('../node_modules/.bin/codex-acp')
agent = pwd.getpwnam('oma-worker')

pin = json.loads((context / "installation.json").read_text())
verify_args = ["--source-sha", pin["sourceSha"], "--lock-sha256", pin["sourceLockSha256"]]
def verify(ok=True):
    result = subprocess.run(['/usr/bin/python3', '-I', '-S', str(managed / 'verify-install.py'), *verify_args], capture_output=True, text=True)
    assert (result.returncode == 0) == ok, result.stderr

verify()
# Agent can execute the harness, but cannot alter harness or trusted worker code.
result = subprocess.run([str(harness / 'bin/codex-acp'), '--help'], user=agent.pw_uid, group=agent.pw_gid, extra_groups=[], capture_output=True, text=True, timeout=15)
assert result.returncode == 0, result.stderr
probe = "import os;from pathlib import Path; p=Path('/opt/oma-harnesses/codex-acp/bin/codex-acp'); assert os.access(p,os.X_OK); assert not os.access(p,os.W_OK); assert not os.access('/opt/oma-managed/worker/node-e2b-work-item-cli.js',os.R_OK)"
subprocess.run(['/usr/bin/python3', '-c', probe], user=agent.pw_uid, group=agent.pw_gid, extra_groups=[], check=True)
# Actual installed harness ACP stdio through the same root-private native helper.
request = Path('/run/oma-managed/harness-spec.json')
request.write_text(json.dumps({'command':str(harness / 'bin/codex-acp'),'args':[], 'env':{'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/home/oma-worker'}}))
request.chmod(0o600)
child = subprocess.Popen(['/usr/bin/python3','-I','-S',str(managed / 'agent-exec.py'),str(request)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    message = {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'oma-template-check','version':'1'}}}
    child.stdin.write(json.dumps(message) + '\n'); child.stdin.flush()
    import select
    assert select.select([child.stdout], [], [], 15)[0], 'installed harness initialize timeout'
    response = json.loads(child.stdout.readline())
    assert response.get('id') == 1 and 'result' in response, response
    assert Path('/proc/%s/status' % child.pid).read_text().split('Uid:')[1].split()[0] == str(agent.pw_uid)
finally:
    child.kill(); child.wait(timeout=5)
# Execute the actual specialized CLI with fixed inventory; missing Work env is
# expected only AFTER loading the mandatory trusted isolation wrapper.
inventory = json.dumps([{'id':'codex-acp','version':'1.8.0','command':str(harness / 'bin/codex-acp')}], separators=(',', ':'))
env = {'PATH':'/usr/local/bin:/usr/bin:/bin', 'OPENMA_ACP_HARNESSES':inventory}
command = ['/usr/local/bin/node', str(managed / 'worker/node-e2b-work-item-cli.js')]
result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
assert result.returncode != 0 and 'ANTHROPIC_ENVIRONMENT_ID is required' in result.stderr, result.stderr
wrapper = managed / 'agent-spawner.mjs'
wrapper.rename(managed / 'hidden.mjs')
result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
assert result.returncode != 0 and 'agent-spawner.mjs' in result.stderr and 'ANTHROPIC_ENVIRONMENT_ID is required' not in result.stderr
(managed / 'hidden.mjs').rename(wrapper)
# Fail closed for writable, tampered and workspace-linked bundle installations.
bundle = managed / 'worker/node-e2b-work-item-cli.js'
bundle.chmod(0o666); verify(False); bundle.chmod(0o644)
original = bundle.read_bytes(); bundle.write_bytes(original + b'\n//tampered'); verify(False); bundle.write_bytes(original)
bundle.unlink(); target = Path('/workspace/forged-worker.js'); target.write_bytes(original); bundle.symlink_to(target); verify(False); bundle.unlink(); bundle.write_bytes(original)
verify()
# A safe resolved target must not conceal a writable lexical parent.
safe = Path('/opt/safe-harness')
harness.rename(safe); harness.symlink_to(safe)
harness.parent.chmod(0o777); verify(False)
harness.parent.chmod(0o755); verify()
harness.unlink(); safe.rename(harness)
# The expected pin is supplied independently, not accepted from manifest.
original_manifest = (managed / 'installation.json').read_text()
mutated = json.loads(original_manifest); mutated['sourceSha'] = '0' * 40
(managed / 'installation.json').write_text(json.dumps(mutated)); verify(False)
(managed / 'installation.json').write_text(original_manifest); verify()
launcher = subprocess.Popen(['/usr/bin/python3','-I','-S',str(managed / 'launcher.py')])
try:
    import time
    for _ in range(100):
        if Path('/run/oma-managed/ready').exists():
            break
        time.sleep(.02)
    assert Path('/run/oma-managed/ready').read_text() == 'oma-managed-v2'
finally:
    launcher.terminate(); launcher.wait(timeout=5)
print(json.dumps({'installation':'PASS','source':'5e1b0e0edbbba72dae4bce4531da4c46bbf978fa','common':'0.13.1','harness':'codex-acp@1.8.0','actualCliWrapperRequired':'PASS','permissionTamperSymlinkRejection':'PASS','cloud':False}))
