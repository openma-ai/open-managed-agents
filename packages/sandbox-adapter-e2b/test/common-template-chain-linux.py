"""Run the entire verifier against disposable root-owned files, no network/npm.
The base template carries no ACP harness; Environment setup installs it.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

context = Path(sys.argv[1] if len(sys.argv) > 1 else '/context')
assert os.geteuid() == 0, 'run in a disposable Linux container as root'
with tempfile.TemporaryDirectory(prefix='oma-trusted-install-') as tmp:
    root = Path(tmp)
    managed = root / 'opt/oma-managed'
    shutil.copytree(context, managed)
    for path in [root / 'opt', *root.rglob('*')]:
        path.chmod(path.stat().st_mode & ~0o022)
    pin = json.loads((managed / 'installation.json').read_text())
    verify = [sys.executable, '-I', '-S', str(managed / 'verify-install.py'),
              '--source-sha', pin['sourceSha'], '--lock-sha256', pin['sourceLockSha256'], str(root)]

    def check(error=None):
        result = subprocess.run(verify, capture_output=True, text=True)
        if error is None:
            assert result.returncode == 0, result.stderr
            assert result.stdout.strip() == 'oma-managed-install-v2'
        else:
            assert result.returncode != 0 and error in result.stderr, result.stderr

    check()
    manifest = managed / 'installation.json'
    original = manifest.read_text()
    for key, value in [('common', '0.13.1'), ('common', '0.14.0-beta.1'), ('common', '0.14.1'),
                       ('sourceSha', '0' * 40), ('sourceLockSha256', '0' * 64)]:
        manifest.write_text(json.dumps({**pin, key: value}))
        check('untrusted worker source or common version')
    manifest.write_text(original)
    for path, error in [(managed / 'worker/node-e2b-work-item-cli.js', 'digest mismatch')]:
        content = path.read_bytes()
        path.write_bytes(content + b'\nTAMPERED')
        check(error)
        path.write_bytes(content)
    bundle = managed / 'worker/node-e2b-work-item-cli.js'
    bundle.chmod(0o666)
    check('root-owned and write-protected')
    bundle.chmod(0o644)
    os.chown(bundle, 65534, 65534)
    check('root-owned and write-protected')
    os.chown(bundle, 0, 0)
    content = bundle.read_bytes()
    bundle.unlink()
    bundle.symlink_to(root / 'workspace/worker.js')
    check('escaped /opt')
    bundle.unlink()
    bundle.write_bytes(content)
    baked = root / 'opt/oma-harnesses/pi-acp/bin/openma-pi-acp'
    baked.parent.mkdir(parents=True)
    baked.write_text('#!/bin/sh\nexit 0\n')
    for path in [root / 'opt/oma-harnesses', *(root / 'opt/oma-harnesses').rglob('*')]:
        path.chmod(path.stat().st_mode & ~0o022)
    check('must not carry a preinstalled ACP harness')
    shutil.rmtree(root / 'opt/oma-harnesses')
    forged = {'id': 'pi-acp', 'version': '0.1.8', 'command': '/opt/oma-harnesses/pi-acp/bin/openma-pi-acp'}
    for entries in [[forged]]:
        manifest.write_text(json.dumps({**pin, 'harnesses': entries}))
        check('unexpected installed harness')
    manifest.write_text(original)
    dependencies = managed / 'worker/node_modules'
    dependencies.mkdir()
    check('unexpected worker dependency directory')
    dependencies.rmdir()
    check()
print('common-0.14.0 file-chain: PASS (ACP-free base; no cloud/build certification)')
