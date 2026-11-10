import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {expect,it} from "vitest";
import {LocalSubprocessSandbox} from "../src/adapters/local-subprocess";

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
