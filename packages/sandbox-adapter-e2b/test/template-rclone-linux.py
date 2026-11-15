"""Offline installer negative test: valid ZIP, wrong digest, real shell/sha256sum.
Only the download boundary is replaced; no network, real rclone, or FUSE mount.
"""
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

command = sys.stdin.read()
with tempfile.TemporaryDirectory(prefix='oma-rclone-install-') as tmp:
    root = Path(tmp)
    archive = root / 'wrong-release.zip'
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('rclone-v1.74.1-linux-amd64/rclone', '#!/bin/sh\necho "rclone v1.74.1"\n')
    shim = root / 'curl'
    shim.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then cp "$OMA_WRONG_ARCHIVE" "$2"; exit; fi
  shift
done
exit 1
''')
    shim.chmod(0o755)
    env = {**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'], 'OMA_WRONG_ARCHIVE': str(archive), 'TMPDIR': str(root)}
    installed = Path('/usr/local/bin/rclone')
    before = installed.read_bytes() if installed.exists() else None
    result = subprocess.run(['/bin/sh', '-c', command], env=env, capture_output=True, text=True)
    assert result.returncode != 0 and 'computed checksum did NOT match' in result.stderr, result.stdout + result.stderr
    assert (installed.read_bytes() if installed.exists() else None) == before, 'corrupt download reached installation'
    assert not list(root.glob('tmp.*/rclone.zip')), 'installer did not clean up archive'
print('rclone installer rejected wrong checksum before installation: PASS')
