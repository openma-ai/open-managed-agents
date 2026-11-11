"""Opt-in real registry install + binary/trust acceptance; no model or E2B calls.
Executed in a disposable root Linux container. Template RUN supplied on stdin.
"""
import json
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

# Parent image uses uv Python; normalize the path provided by the template's apt
# step so the actual unmodified install RUN and agent-exec boundary can execute.
if not Path('/usr/bin/python3').exists():
    Path('/usr/bin/python3').symlink_to(sys.executable)
context = Path('/context')
managed = Path('/opt/oma-managed')
harness = Path('/opt/oma-harnesses/codex-acp')
pi = Path('/opt/oma-harnesses/pi-acp')
managed.mkdir(mode=0o700, parents=True)
shutil.copytree(context, managed, dirs_exist_ok=True)
managed.chmod(0o700)
shutil.copytree(context / 'harness', harness)
(pi / 'bin').mkdir(parents=True)
Path('/run/oma-managed').mkdir(mode=0o700, parents=True, exist_ok=True)
try:
    agent = pwd.getpwnam('oma-worker')
except KeyError:
    subprocess.run(['useradd', '--create-home', 'oma-worker'], check=True)
    agent = pwd.getpwnam('oma-worker')
# Execute the real template npm/link/verify RUN, not a test reimplementation.
subprocess.run(['/bin/sh', '-ec', sys.stdin.read()], check=True)
pin = json.loads((managed / 'installation.json').read_text())
verify = ['python3', '-I', '-S', str(managed / 'verify-install.py'), '--source-sha', pin['sourceSha'], '--lock-sha256', pin['sourceLockSha256']]

def check(error=None):
    result = subprocess.run(verify, capture_output=True, text=True)
    if error:
        assert result.returncode != 0 and error in result.stderr, result.stderr
    else:
        assert result.returncode == 0, result.stderr

check()
# Both installed commands run only through the existing irreversible UID/env boundary.
def isolated(command, args):
    request = Path('/run/oma-managed/pi-test-spec.json')
    request.write_text(json.dumps({'command': command, 'args': args, 'env': {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/oma-worker'}}))
    request.chmod(0o600)
    return subprocess.run(['python3', '-I', '-S', str(managed / 'agent-exec.py'), str(request)],
                          env={**os.environ, 'OPENMA_SANDBOX_TOKEN': 'test-management-secret'},
                          capture_output=True, text=True, timeout=30)

result = isolated(str(pi / 'bin/openma-pi-acp'), ['--version'])
assert result.returncode == 0 and '0.1.8' in result.stdout, result.stdout + result.stderr
print('pi binary --version:', result.stdout.strip())
result = isolated(str(harness / 'bin/codex-acp'), ['--help'])
assert result.returncode == 0, result.stderr
probe = "const fs=require('node:fs'),assert=require('node:assert/strict'); assert.notEqual(process.getuid(),0); assert.equal(process.env.OPENMA_SANDBOX_TOKEN,undefined); assert.throws(()=>fs.accessSync('/opt/oma-managed/installation.json',fs.constants.R_OK)); assert.throws(()=>fs.accessSync('/opt/oma-harnesses/pi-acp/bin/openma-pi-acp',fs.constants.W_OK)); console.log('isolated')"
result = isolated('/usr/local/bin/node', ['-e', probe])
assert result.returncode == 0 and result.stdout.strip() == 'isolated', result.stderr
# Tampering the real installed pi version or executable permissions fails closed.
package = harness / 'node_modules/@openma/pi-acp/package.json'
original = package.read_text()
metadata = json.loads(original)
package.write_text(json.dumps({**metadata, 'version': '0.1.9'}))
check('harness version mismatch')
package.write_text(original)
command = (pi / 'bin/openma-pi-acp').resolve()
mode = command.stat().st_mode
command.chmod(0o666)
check('root-owned and write-protected')
command.chmod(mode)
check()
print('real npm pi/codex installation + version + UID/credential/trust file-chain: PASS')
