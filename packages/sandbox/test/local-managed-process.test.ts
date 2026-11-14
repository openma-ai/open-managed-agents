import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {ChildProcess} from "node:child_process";
import {existsSync} from "node:fs";
import {LocalSubprocessSandbox} from "../src/adapters/local-subprocess";

it("destroy reports unconfirmed managed exit and retains ownership for an explicit retry",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-managed-timeout-"));const sandbox=new LocalSubprocessSandbox({workdir:root});
 const handle=await sandbox.startManagedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{}});
 const original=ChildProcess.prototype.kill;
 const blocked=vi.spyOn(ChildProcess.prototype,"kill").mockImplementation(function(this:ChildProcess,signal){return this.pid===handle.pid?true:original.call(this,signal);});
 try {
  const first=sandbox.destroy();expect(sandbox.destroy()).toBe(first);
  await expect(first).rejects.toMatchObject({name:"ManagedProcessCleanupError",code:"MANAGED_PROCESS_CLEANUP_FAILED",processIds:[handle.id]});
  expect(existsSync(root)).toBe(true);expect(()=>process.kill(handle.pid,0)).not.toThrow();
  await expect(sandbox.startManagedProcess({command:process.execPath,env:{}})).rejects.toThrow(/clos/);
  const retry=sandbox.destroy();expect(retry).not.toBe(first);
  await expect(retry).rejects.toMatchObject({code:"MANAGED_PROCESS_CLEANUP_FAILED",processIds:[handle.id]});
  blocked.mockRestore();
  const recovered=sandbox.destroy();await recovered;
  expect(sandbox.destroy()).toBe(recovered);expect(existsSync(root)).toBe(false);
  expect(()=>process.kill(handle.pid,0)).toThrow();
 }finally{blocked.mockRestore();await handle.kill("SIGKILL");await sandbox.destroy();await rm(root,{recursive:true,force:true});}
},10_000);

it("destroy keeps legacy log-process kill failures best-effort",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-log-kill-"));const sandbox=new LocalSubprocessSandbox({workdir:root});
 const handle=await sandbox.startProcess("exec sleep 30");
 const blocked=vi.spyOn(ChildProcess.prototype,"kill").mockImplementation(()=>{throw new Error("injected legacy kill failure");});
 try {await sandbox.destroy();expect(existsSync(root)).toBe(false);}
 finally{blocked.mockRestore();await handle?.kill("SIGKILL");await sandbox.destroy();await rm(root,{recursive:true,force:true});}
});

it("destroy waits for a starting native child and forbids launches once closing",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-managed-race-"));const sandbox=new LocalSubprocessSandbox({workdir:root});
 await sandbox.egressRelayPort();
 let handle:Awaited<ReturnType<typeof sandbox.startManagedProcess>>|undefined;
 try {
  const starting=sandbox.startManagedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{}});
  const closing=sandbox.destroy();
  await expect(sandbox.startManagedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{}})).rejects.toThrow(/clos/);
  await closing;handle=await starting;
  expect(await handle.getStatus()).toBe("killed");
  expect(()=>process.kill(handle!.pid,0)).toThrow();
 }finally{await handle?.kill("SIGKILL");await sandbox.destroy();await rm(root,{recursive:true,force:true});}
});

it("destroy waits for process exit, not descendants holding inherited output pipes",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-managed-pipe-"));const sandbox=new LocalSubprocessSandbox({workdir:root});let pid:number|undefined;let closing:Promise<void>|undefined;
 try {
  await sandbox.startProcess("sleep 30 & echo $! > descendant.pid");
  for(let i=0;i<100;i++){try{pid=Number(await readFile(join(root,"descendant.pid"),"utf8"));if(pid)break;}catch{}await new Promise(r=>setTimeout(r,5));}
  await new Promise(r=>setTimeout(r,100));closing=sandbox.destroy();
  expect(await Promise.race([closing.then(()=>"closed"),new Promise(r=>setTimeout(()=>r("hung"),400))])).toBe("closed");
 }finally{if(pid)try{process.kill(pid,"SIGKILL");}catch{}await closing;await sandbox.destroy();await rm(root,{recursive:true,force:true});}
});

it("failed native startup is observed while destroy drains starting processes",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-managed-fail-"));const sandbox=new LocalSubprocessSandbox({workdir:root});
 try {
  const starting=sandbox.startManagedProcess({command:"/nonexistent/openma-runner",env:{}});
  const observed=expect(starting).rejects.toThrow();
  await sandbox.destroy();await observed;
 }finally{await sandbox.destroy();await rm(root,{recursive:true,force:true});}
});

it("starts a management-only native argv process with replacement env before any shell or Node startup",async()=>{
 const root=await mkdtemp(join(process.cwd(),".local-managed-"));const sandbox=new LocalSubprocessSandbox({workdir:root});
 await sandbox.setEnvVars({NODE_OPTIONS:"--require=/invalid/stale.js",ANTHROPIC_API_KEY:"stale",ANTHROPIC_ENVIRONMENT_KEY:"standing",BASH_ENV:"/invalid/hook",PATH:"/invalid/path"});
 try {
  const method=(sandbox as unknown as {startManagedProcess?:Function}).startManagedProcess;
  expect(typeof method).toBe("function");
  const result=await method!.call(sandbox,{command:process.execPath,args:["-e","require('node:fs').writeFileSync('launch.json',JSON.stringify({safe:process.env.EXPLICIT,stale:process.env.ANTHROPIC_API_KEY,standing:process.env.ANTHROPIC_ENVIRONMENT_KEY,node:process.env.NODE_OPTIONS,path:process.env.PATH,bash:process.env.BASH_ENV}))"],env:{EXPLICIT:"safe",PATH:"/usr/bin:/bin"}});
  expect("stdin" in result).toBe(false);expect("stdout" in result).toBe(false);expect("getLogs" in result).toBe(false);
  for(let i=0;i<100&&await result.getStatus()==="running";i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(await result.getStatus()).toBe("completed");
  expect(JSON.parse(await readFile(join(root,"launch.json"),"utf8"))).toEqual({safe:"safe",path:"/usr/bin:/bin"});
 }finally{await sandbox.destroy();await rm(root,{recursive:true,force:true});}
});
