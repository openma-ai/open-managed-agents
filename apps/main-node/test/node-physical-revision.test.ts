import { expect,it } from "vitest";
import { coldFixture } from "./node-cold-finalization.fixture.js";

it("hot finalization refuses a management process killed during real archive upload",async()=>{
 const f=await coldFixture(false,false);const process=await f.sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});
 const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);let killed=false;
 f.runtime.filesBlob.put=async(...args)=>{const result=await put(...args);if(!killed && args[0].includes("managed-session-workspace-checkpoints")){await process.kill("SIGKILL");killed=true;}return result;};
 try{const response=await f.request("finalize",{stopReason:{type:"end_turn"}});expect(killed).toBe(true);expect(response.status).toBe(502);expect(await response.json()).toMatchObject({terminal:{stopReason:{type:"retries_exhausted"}}});expect(await f.checkpoint()).toBeNull();}
 finally{await process.kill("SIGKILL");}
});
it("one Work attempt cannot replace its captured hot management process",async()=>{
 const f=await coldFixture(false,false);const process=await f.sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});await process.kill("SIGKILL");
 await expect(f.sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}})).rejects.toThrow(/process|launch/);
 expect((await f.request("checkpoint")).status).toBe(502);
});
it("confirmed unreferenced CAS loser removes exactly its workspace and native-state blobs",async()=>{
 const f=await coldFixture(false,false);await f.sandbox.writeFile("/oma/harness-state/state.json","state");
 const process=await f.sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});
 const keys:string[]=[];const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);
 f.runtime.filesBlob.put=async(...args)=>{const value=await put(...args);if(args[0].includes("managed-session-workspace-checkpoints"))keys.push(args[0]);return value;};
 await f.sql.exec("CREATE TRIGGER reject_work_checkpoint BEFORE UPDATE ON managed_session_workspace_checkpoints BEGIN SELECT RAISE(IGNORE); END");
 try {expect((await f.request("checkpoint")).status).toBe(502);expect(await f.checkpoint()).toBeNull();expect(keys).toHaveLength(2);for(const key of keys)expect(await f.runtime.filesBlob.head(key)).toBeNull();}
 finally{await process.kill("SIGKILL");}
});

it.each(["committed-response-loss","reference-read-failure","delete-failure","put-response-loss"])("candidate cleanup retains uncertain or referenced allocation: %s",async kind=>{
 const f=await coldFixture();await f.sandbox.writeFile("proof.txt","winner");
 const keys:string[]=[];const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);const batch=f.sql.batchChecked!.bind(f.sql);const prepare=f.sql.prepare.bind(f.sql);
 f.runtime.filesBlob.put=async(...args)=>{const result=await put(...args);if(args[0].includes("managed-session-workspace-checkpoints")){keys.push(args[0]);if(kind==="put-response-loss")throw Error("PUT response lost");}return result;};
 if(kind==="committed-response-loss")f.sql.batchChecked=async(...args)=>{await batch(...args);throw Error("commit response lost");};
 else await f.sql.exec("CREATE TRIGGER reject_work_checkpoint BEFORE UPDATE ON managed_session_workspace_checkpoints BEGIN SELECT RAISE(IGNORE); END");
 if(kind==="reference-read-failure")f.sql.prepare=((query:string)=>{if(query.startsWith("SELECT candidate_id,candidate_json"))throw Error("reference lookup unknown");return prepare(query);}) as typeof f.sql.prepare;
 if(kind==="delete-failure")f.runtime.filesBlob.delete=async()=>{throw Error("delete unavailable");};
 expect((await f.request("checkpoint")).status).toBe(502);expect(keys.length).toBeGreaterThan(0);
 for(const key of keys)expect(await f.runtime.filesBlob.head(key)).not.toBeNull();
 if(kind==="committed-response-loss")expect(await f.checkpoint()).not.toBeNull();
});
it("unknown hot process status is not gone/success and cannot create checkpoint",async()=>{
 const f=await coldFixture(false,false);const h=await f.sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});
 try{h.getStatus=async()=>{throw Error("provider status unavailable");};expect((await f.request("checkpoint")).status).toBe(502);expect(await f.checkpoint()).toBeNull();expect(await f.sandbox.exec("printf still-live")).toBe("still-live");}finally{await h.kill("SIGKILL");}
});
it("partial native-state allocation is removed when subsequent workspace PUT fails before allocation",async()=>{
 const f=await coldFixture();await f.sandbox.writeFile("/oma/harness-state/state.json","native");const keys:string[]=[];const put=f.runtime.filesBlob.put.bind(f.runtime.filesBlob);
 f.runtime.filesBlob.put=async(...args)=>{if(args[0].includes("managed-session-workspace-checkpoints") && !args[0].endsWith(".state.tar"))throw Error("workspace write refused");const value=await put(...args);keys.push(args[0]);return value;};
 expect((await f.request("checkpoint")).status).toBe(502);expect(keys.some(k=>k.endsWith(".state.tar"))).toBe(true);for(const key of keys)expect(await f.runtime.filesBlob.head(key)).toBeNull();
});
