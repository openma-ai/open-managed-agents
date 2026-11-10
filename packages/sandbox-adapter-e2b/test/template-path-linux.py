"""Exercise production trusted() itself against lexical and multi-link ancestors."""
import os
from pathlib import Path
source = Path('/source/template/verify-install.py').read_text().split('manifest = json.loads')[0]
# Supply only test root prefix; source-pin parsing, when present, is explicit.
import sys
sys.argv = ['verify-install.py', '--source-sha', 'a'*40, '--lock-sha256', 'b'*64, '/']
namespace = {}
exec(source, namespace)
trusted = namespace['trusted']
Path('/opt/safe-harness').mkdir(parents=True)
Path('/opt/safe-harness/entry').write_text('safe')
Path('/opt/oma-harnesses').mkdir()
Path('/opt/oma-harnesses/codex-acp').symlink_to('/opt/safe-harness')
trusted(Path('/opt/oma-harnesses/codex-acp/entry'))
Path('/opt/oma-harnesses').chmod(0o777)
try:
    trusted(Path('/opt/oma-harnesses/codex-acp/entry'))
except ValueError:
    pass
else:
    raise AssertionError('mutable lexical ancestor accepted')
Path('/opt/oma-harnesses').chmod(0o755)
Path('/opt/links').mkdir()
Path('/opt/links/second').symlink_to('/opt/safe-harness')
Path('/opt/oma-harnesses/codex-acp').unlink()
Path('/opt/oma-harnesses/codex-acp').symlink_to('/opt/links/second')
trusted(Path('/opt/oma-harnesses/codex-acp/entry'))
Path('/opt/links').chmod(0o777)
try:
    trusted(Path('/opt/oma-harnesses/codex-acp/entry'))
except ValueError:
    pass
else:
    raise AssertionError('mutable intermediate symlink ancestor accepted')
print('lexical and intermediate symlink ancestors: PASS')
