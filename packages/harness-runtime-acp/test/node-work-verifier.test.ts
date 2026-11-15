import {expect,it} from "vitest";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeSpawner} from "@open-managed-agents/acp-runtime/node-spawner";
import * as module from "../src/node-work-verifier.js";
it("runs a real rule script in workspace, returns actual exit/output and withholds inherited secrets",async()=>{
 const cwd=await mkdtemp(join(tmpdir(),"work-verifier-"));process.env.OPENMA_VERIFIER_TEST_SECRET="must-not-inherit";
 try {
  const exec=module.createWorkVerifierExec(new NodeSpawner(),cwd);
  const result=await exec("printf '%s' \"${OPENMA_VERIFIER_TEST_SECRET-unset}\" > proof; printf 'detail'; exit 7",{timeoutMs:1000},new AbortController().signal);
  expect(result).toEqual({exit_code:7,output:"detail"});expect(await readFile(join(cwd,"proof"),"utf8")).toBe("unset");
 }finally{delete process.env.OPENMA_VERIFIER_TEST_SECRET;await rm(cwd,{recursive:true,force:true});}
});
it("timeout kills and joins actual child instead of reporting successful script",async()=>{
 const exec=module.createWorkVerifierExec(new NodeSpawner(),tmpdir());
 await expect(exec("sleep 30",{timeoutMs:20},new AbortController().signal)).rejects.toThrow(/timed out/);
});
it("abort kills and joins native verification activity",async()=>{
 const controller=new AbortController();const exec=module.createWorkVerifierExec(new NodeSpawner(),tmpdir());
 const promise=exec("sleep 30",{timeoutMs:1000},controller.signal);setTimeout(()=>controller.abort(new DOMException("cancelled","AbortError")),20);
 await expect(promise).rejects.toMatchObject({name:"AbortError"});
});
it("refuses an unconfirmed kill within a bounded deadline",async()=>{
 const empty=()=>new ReadableStream<Uint8Array>({start(c){c.close();}});
 const exec=module.createWorkVerifierExec({async spawn(){return {stdin:new WritableStream<Uint8Array>(),stdout:empty(),stderr:empty(),kill:async()=>{},exited:new Promise<never>(()=>{})};}},tmpdir());
 const start=Date.now();
 await expect(exec("blocked",{timeoutMs:5},new AbortController().signal)).rejects.toThrow(/exit.*unconfirmed|unconfirmed.*exit/i);
 expect(Date.now()-start).toBeLessThan(3000);
},4000);
