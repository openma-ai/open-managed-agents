import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { E2BSandboxExecutor } from "../src/e2b";
const directory = await mkdtemp("/workspace/locator-adapter-");
const launcher = spawn("/usr/bin/python3", ["-I", "-S", "/source/template/launcher.py", directory]);
try {
  for (let n=0;;n++) { try { await readFile(directory+"/ready"); break; } catch(e) { if(n>200) throw e; await new Promise(r=>setTimeout(r,10)); } }
  const sb = { sandboxId: "physical-one", files: { read: (p:string)=>readFile(p,"utf8"), write: (p:string,d:string|Uint8Array)=>writeFile(p,d) }, commands:{run:async()=>{throw Error("shell forbidden")}},kill:async()=>{} };
  const options={managedBootstrap:{directory}};
  const first=new E2BSandboxExecutor(sb,options);
  const identity={workspaceId:"w",sessionId:"s",workId:"a",attemptId:"1"};
  const a=await first.startManagedProcess({command:"/usr/local/bin/node",args:["-e","setInterval(()=>{},1000)"],env:{}},identity);
  const recovered=new E2BSandboxExecutor(sb,options);
  const locator=await recovered.inspectManagedProcessSlot();
  assert.equal(locator.id,a.id);assert.deepEqual(locator.identity,identity);
  await assert.rejects(recovered.restoreManagedProcess({...locator,identity:{...identity,workId:"wrong"}}));
  const handle=await recovered.restoreManagedProcess(locator);await handle.kill("SIGKILL");
  const b=await recovered.startManagedProcess({command:"/usr/local/bin/node",args:["-e","setInterval(()=>{},1000)"],env:{}},{...identity,workId:"b",attemptId:"2"});
  await handle.kill("SIGKILL");assert.equal(await b.getStatus(),"running");
  assert.equal((await recovered.inspectManagedProcessSlot()).id,b.id);
  await assert.rejects(new E2BSandboxExecutor({...sb,sandboxId:"physical-other"},options).restoreManagedProcess(locator));
  await b.kill("SIGKILL");
  console.log("new adapter instance inspect/restore exact old handle + staleA kill safe PASS");
} finally {
  const exit=new Promise(r=>launcher.once("exit",r));launcher.kill("SIGTERM");await exit;
}
