import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { E2B_NATIVE_DRAIN_PYTHON, e2bNativeDrainCommand } from "../src/native-drain";
// Actual shipped Python + real Unix HTTP server; Linux mount/proc identity is
// the only substituted local boundary. No cloud/FUSE installation required.
it("awaits actual queue/in-flight acknowledgements and expedites once",()=>{
 const result=spawnSync("python3",["-c",E2B_NATIVE_DRAIN_PYTHON+String.raw`
import tempfile, threading, socketserver, http.server
with tempfile.TemporaryDirectory() as directory:
    calls=[]; count=[0]
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append((self.path,data))
            if self.path=='/vfs/stats':
                count[0]+=1
                value={'fs':':s3:b/p','diskCache':{'uploadsQueued':int(count[0]<3),'uploadsInProgress':int(count[0]==3),'erroredFiles':0,'outOfSpace':False}}
            elif self.path=='/vfs/queue': value={'queue':[{'id':7,'uploading':count[0]==3}] if count[0]<4 else []}
            else: value={}
            raw=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    with socketserver.UnixStreamServer(directory+'/rc.sock',Handler) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        check=lambda m:'pid:start';time.sleep=lambda n:None
        main([{'target':'/mnt/session/outputs','remote':':s3:b/p','socket':directory+'/rc.sock'}])
        assert count[0]>=5
        assert [v for p,v in calls if p=='/vfs/queue-set-expiry']==[{'id':7,'expiry':-1000000000}]
        server.shutdown();thread.join()
`],{encoding:"utf8"});
 expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual({type:"drained",version:1});
});
it.each(["missing","errors","queue","space","timeout","changed"])("refuses %s instead of acknowledging drain",kind=>{
 const result=spawnSync("python3",["-c",E2B_NATIVE_DRAIN_PYTHON+`\nkind=${JSON.stringify(kind)}\n`+String.raw`
check=lambda m:'identity'
def fake_rc(m,path,args):
    if path=='vfs/queue': return {'queue':None if kind=='queue' else []}
    if path=='vfs/queue-set-expiry': return {}
    cache={'uploadsQueued':int(kind=='timeout'),'uploadsInProgress':0,'erroredFiles':int(kind=='errors'),'outOfSpace':kind=='space'}
    if kind=='missing': del cache['uploadsQueued']
    return {'fs':m['remote'],'diskCache':cache}
rc=fake_rc;time.sleep=lambda n:None
if kind=='timeout':
    ticks=iter([0,99]);time.monotonic=lambda:next(ticks)
if kind=='changed':
    checks=iter(['old','new']);check=lambda m:next(checks)
main([{'remote':'test'}])
`],{encoding:"utf8"});
 expect(result.status).not.toBe(0);expect(result.stdout).not.toContain('"drained"');
});
it("executes fail-closed capability probe against absent root-owned endpoint",()=>{
 const result=spawnSync("python3",["-c",E2B_NATIVE_DRAIN_PYTHON+"\nmain([{'target':'/mnt/session/outputs','remote':'test','socket':'/absent/rc.sock'}])"],{encoding:"utf8"});
 expect(result.status).not.toBe(0);expect(result.stdout).toBe("");
 expect(()=>e2bNativeDrainCommand([{target:"/mnt/memory/../outputs",remote:"x",endpoint:"https://example.test"}])).toThrow();
});
it("accepts only rclone's hashed config suffix, not a different backend or prefix",()=>{
 const result=spawnSync("python3",["-c",E2B_NATIVE_DRAIN_PYTHON+String.raw`
assert same_remote(':s3{abc_12}:bucket/prefix', ':s3:bucket/prefix')
assert not same_remote(':s3{abc_12}:bucket/other', ':s3:bucket/prefix')
assert not same_remote(':local:bucket/prefix', ':s3:bucket/prefix')
`],{encoding:"utf8"});expect(result.status,result.stderr).toBe(0);
});
