"""Real launcher dispatch/hash code, fake Linux syscall edges; NOT Linux/cloud certification."""
import ast, hashlib, json, pathlib, types, zlib
from unittest.mock import Mock
import sys
source = pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else pathlib.Path(__file__).parent.parent / 'template/launcher.py'
tree = ast.parse(source.read_text())
unit = ast.Module(body=[n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))], type_ignores=[])
ns = {}; exec(compile(unit, str(source), 'exec'), ns)
alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; random = 'A'*43
crc = zlib.crc32(('oma_sbx_'+random).encode()); check = ''
for _ in range(6): check = alphabet[crc % 62] + check; crc //= 62
token = 'oma_sbx_' + random + check
identity = dict(workspaceId='w',sessionId='s',workId='a',attemptId='environment-work-claim:2')
ns.update(root=pathlib.Path('/unused'), children={}, identities={}, holders={}, epoch='epoch', slot=None, cleaned=set())
ns['os'] = Mock(wraps=ns['os'])
ns['os'].open.return_value = 10
ns['os'].fstat.return_value = types.SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=1)
ns['os'].close.return_value = None; ns['os'].waitid = Mock(return_value=None)
ns['os'].P_PID=1; ns['os'].WEXITED=4; ns['os'].WNOHANG=1; ns['os'].WNOWAIT=0x1000000
for name in ['O_RDWR','O_CREAT','O_NOFOLLOW','O_CLOEXEC']: setattr(ns['os'],name,1)
ns['fcntl'] = Mock(); ns['fcntl'].LOCK_EX=1; ns['fcntl'].LOCK_NB=2; ns['subprocess'] = Mock(); ns['subprocess'].Popen.return_value.pid = 41
ns['dispatch'](dict(op='start',id='a',identity=identity,sandboxId='physical',spec=dict(command='/bin/worker',env={'OPENMA_SANDBOX_TOKEN':token})))
loc = ns['dispatch']({'op':'inspect-slot'})['locator']
assert loc.get('holderHash') == hashlib.sha256(random.encode()).hexdigest(), loc
assert loc.get('sandboxId') == 'physical', loc
assert loc['id']=='a' and loc['epoch']=='epoch' and loc['identity']==identity
assert token not in json.dumps(loc)
for changes in [{'holderHash':'f'*64},{'sandboxId':'other'},{'epoch':'wrong'},{'identity':{**identity,'attemptId':'environment-work-claim:3'}}]:
 req=dict(op='kill',target='a',epoch='epoch',identity=identity,sandboxId='physical',holderHash=loc['holderHash'],signal='SIGKILL');req.update(changes)
 try: ns['dispatch'](req)
 except (ValueError, KeyError): pass
 else: raise AssertionError('tampered binding accepted: '+str(changes))
assert not ns['os'].killpg.called
ns['dispatch'](dict(op='start',id='legacy',identity=identity,spec=dict(command='/bin/worker',env={})))
legacy=ns['dispatch']({'op':'inspect-slot'})['locator']; assert not legacy.get('holderHash')
print('holder binding PASS (syscall fakes)')
