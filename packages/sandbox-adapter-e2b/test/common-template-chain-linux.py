"""Run the entire verifier against disposable root-owned files, no network/npm.
The harness executable is a fixture: this tests installation trust, not ACP execution.
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
    harness = root / 'opt/oma-harnesses/codex-acp'
    shutil.copytree(context, managed)
    shutil.copytree(context / 'harness', harness)
    package = harness / 'node_modules/@agentclientprotocol/codex-acp/package.json'
    package.parent.mkdir(parents=True)
    package.write_text('{"version":"1.8.0"}')
    command = harness / 'bin/codex-acp'
    command.parent.mkdir()
    command.write_text('#!/bin/sh\nexit 0\n')
    command.chmod(0o755)
    pi_package = harness / 'node_modules/@openma/pi-acp/package.json'
    pi_package.parent.mkdir(parents=True)
    pi_package.write_text('{"version":"0.1.8"}')
    pi_command = root / 'opt/oma-harnesses/pi-acp/bin/openma-pi-acp'
    pi_command.parent.mkdir(parents=True)
    pi_command.write_text('#!/bin/sh\nexit 0\n')
    pi_command.chmod(0o755)
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
    for path, error in [(managed / 'worker/node-e2b-work-item-cli.js', 'digest mismatch'),
                        (harness / 'package-lock.json', 'lock mismatch')]:
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
    package.write_text('{"version":"1.7.0"}')
    check('harness version mismatch')
    package.write_text('{"version":"1.8.0"}')
    command.chmod(0o644)
    check('not executable')
    command.chmod(0o755)
    pi_package.write_text('{"version":"0.1.9"}')
    check('harness version mismatch')
    pi_package.write_text('{"version":"0.1.8"}')
    pi_command.chmod(0o666)
    check('root-owned and write-protected')
    pi_command.chmod(0o755)
    pi_command.chmod(0o644)
    check('not executable')
    pi_command.chmod(0o755)
    pi_command.unlink()
    pi_command.symlink_to(root / 'workspace/forged-pi')
    check('escaped /opt')
    pi_command.unlink()
    pi_command.write_text('#!/bin/sh\nexit 0\n')
    pi_command.chmod(0o755)
    for entries in [pin['harnesses'][:1], [*pin['harnesses'], pin['harnesses'][1]]]:
        manifest.write_text(json.dumps({**pin, 'harnesses': entries}))
        check('unexpected installed harness')
    manifest.write_text(original)
    dependencies = managed / 'worker/node_modules'
    dependencies.mkdir()
    check('unexpected worker dependency directory')
    dependencies.rmdir()
    check()
print('common-0.14.0 file-chain: PASS (fixture harness; no cloud/build certification)')
