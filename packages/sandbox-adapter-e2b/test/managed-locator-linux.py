import json, os, subprocess, tempfile, time, uuid, pwd
from pathlib import Path
root=Path(tempfile.mkdtemp(dir='/workspace'));root.chmod(0o700)
p=subprocess.Popen(['/usr/bin/python3','-I','-S','/source/template/launcher.py',str(root)])
def wait(fn):
 for _ in range(300):
  try:
   x=fn()
   if x:return x
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.01)
 raise AssertionError('timeout')
def req(body):
 ident=str(uuid.uuid4());(root/(ident+'.json')).write_text(json.dumps({'id':ident,**body}));(root/(ident+'.go')).touch()
 return wait(lambda:json.loads((root/(ident+'.response.json')).read_text()))
def start(identity):
 return req({'op':'start','identity':identity,'spec':{'command':'/usr/local/bin/node','args':['-e','setInterval(()=>{},1000)'],'env':{'SYNTHETIC_TOKEN':'not-real'},'cwd':'/workspace'}})
a={'workspaceId':'w','sessionId':'s','workId':'a','attemptId':'1'};b={**a,'workId':'b','attemptId':'2'}
try:
 wait(lambda:(root/'ready').exists())
 first=start(a);assert first['ok']
 inspected=req({'op':'inspect-slot'});assert inspected['ok'],inspected
 loc=inspected['locator'];assert loc['identity']==a and loc['status']=='running'
 assert 'SYNTHETIC_TOKEN' not in json.dumps(inspected) and 'not-real' not in json.dumps(inspected)
 assert not req({'op':'kill','target':loc['id'],'epoch':loc['epoch'],'identity':b,'signal':'SIGKILL'})['ok']
 assert req({'op':'kill','target':loc['id'],'epoch':loc['epoch'],'identity':a,'signal':'SIGKILL'})['ok']
 second=start(b);assert second['ok']
 assert req({'op':'kill','target':loc['id'],'epoch':loc['epoch'],'identity':a,'signal':'SIGKILL'})['ok']
 current=req({'op':'inspect-slot'})['locator'];assert current['identity']==b and current['status']=='running' and current['id']!=loc['id']
 assert not req({'op':'kill','target':current['id'],'epoch':'wrong','identity':b,'signal':'SIGKILL'})['ok']
 agent=pwd.getpwnam('oma-worker')
 code="from pathlib import Path;import sys; p=Path(sys.argv[1]); assert not __import__('os').access(p,__import__('os').R_OK); assert not __import__('os').access(p,__import__('os').W_OK)"
 subprocess.run(['/usr/bin/python3','-c',code,str(root)],user=agent.pw_uid,group=agent.pw_gid,extra_groups=[],check=True)
 p.terminate();p.wait(timeout=5)
 p=subprocess.Popen(['/usr/bin/python3','-I','-S','/source/template/launcher.py',str(root)])
 wait(lambda:(root/'ready').exists())
 assert not req({'op':'kill','target':current['id'],'epoch':current['epoch'],'identity':b,'signal':'SIGKILL'})['ok']
 assert not req({'op':'inspect-slot'})['ok']
 # A busy lock without this launcher's locator must not be guessed/recovered.
 import fcntl
 descriptor=os.open(root/'worker.lock',os.O_RDWR)
 fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert not start(a)['ok']
 assert not req({'op':'inspect-slot'})['ok']
 os.close(descriptor)
 print('locator A-inspect-kill B-start staleA-safe + private identity + restart failclosed PASS')
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=5)
