"""Actual rclone VFS + filesystem backend; only Linux root/mount/proc checks
are substituted on macOS. Executes the EXACT command received from Node."""
import os,pathlib,subprocess,socket,http.client,json,time,sys,tempfile
with tempfile.TemporaryDirectory(prefix='node-rc-',dir=str(pathlib.Path.cwd())) as d:
 os.chdir(d);os.mkdir('remote');remote=str(pathlib.Path('remote').resolve())
 listener=socket.socket();listener.bind(('127.0.0.1',0));port=listener.getsockname()[1];listener.close()
 with open('daemon.log','w') as log:
  p=subprocess.Popen(['rclone','serve','webdav',remote,'--addr',f'127.0.0.1:{port}','--vfs-cache-mode','writes','--vfs-write-back','1h','--cache-dir','cache','--rc','--rc-no-auth','--rc-addr','unix://rc.sock'],stdout=log,stderr=log)
  try:
   deadline=time.monotonic()+10
   while True:
    try:
     c=http.client.HTTPConnection('127.0.0.1',port,timeout=2);c.request('PUT','/proof.txt',b'physical-delayed-output');r=c.getresponse();r.read();assert r.status in (200,201,204);c.close();break
    except (OSError,http.client.HTTPException):
     if time.monotonic()>deadline:raise
     time.sleep(.05)
   assert not os.path.exists(remote+'/proof.txt')
   print(json.dumps({'remote':remote}),flush=True)
   command=json.loads(sys.stdin.readline())['command']
   code=command.split("\n",1)[1].rsplit('\nmain(',1)[0]
   ns={};exec(code,ns)
   m={'socket':'rc.sock','remote':remote,'target':remote}
   counters,queue=ns['observe'](m);assert queue and counters['uploadsQueued']>0
   ns['check']=lambda m:'local-physical-binding-substitute'
   ns['main']([m])
   assert pathlib.Path(remote+'/proof.txt').read_bytes()==b'physical-delayed-output'
   print(json.dumps({'backend':'physical-delayed-output','queue':ns['observe'](m)[1]}),flush=True)
  finally:p.terminate();p.wait(timeout=10)
