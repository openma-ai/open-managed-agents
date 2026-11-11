import { expect,it } from "vitest";
import { createNodeSessionStorage } from "../../../packages/control-plane-node/src/lib/node-session-storage.js";
import { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
it("native durable output capability alone cannot acknowledge upload completion",async()=>{
 const runtime=new E2BSandboxExecutor({sandboxId:"physical",commands:{run:async()=>{throw Error("RC unavailable");}},files:{read:async()=>"",write:async()=>{}},kill:async()=>{}} as never,{memoryBucket:{endpoint:"http://unused",accessKey:"unused",secretKey:"unused",bucketName:"unused"}});
 let published=false;
 const storage=createNodeSessionStorage({memoryStoreMode:"native",memories:()=>({}) as never,memoryBlobs:{} as never,outputs:{} as never,workOutputs:{synchronize:async()=>{published=true;}},inputs:()=>({}) as never,isFenceActive:async()=>false,warn:()=>{}});
 await expect(storage.synchronizeWork!({workspaceId:"ws",session:{id:"session",resources:[]} as never,environment:{id:"env"} as never,sandbox:runtime,runtimeGeneration:"physical",workAuthority:{attempt:{workspaceId:"ws",sessionId:"session",executionId:"work",attemptId:"environment-work-claim:1",ownerId:"env",generation:1},holderHash:"a".repeat(64),isCurrent:async()=>true}})).rejects.toThrow();
 expect(published).toBe(false);
});

it("shared Session outputs are not natively mounted, so a durable-capable provider needs no output drain",async()=>{
 const commands:string[]=[];
 const runtime=new E2BSandboxExecutor({sandboxId:"physical",commands:{run:async(command:string)=>{commands.push(command);throw Error("RC unavailable");}},files:{read:async()=>"",write:async()=>{}},kill:async()=>{}} as never,{memoryBucket:{endpoint:"http://unused",accessKey:"unused",secretKey:"unused",bucketName:"unused"}});
 let published=false;
 const storage=createNodeSessionStorage({memoryStoreMode:"native",memories:()=>({}) as never,memoryBlobs:{} as never,outputs:{} as never,sharedOutputs:{} as never,workOutputs:{synchronize:async()=>{published=true;}},inputs:()=>({}) as never,isFenceActive:async()=>false,warn:()=>{}});
 await storage.synchronizeWork!({workspaceId:"ws",session:{id:"session",resources:[]} as never,environment:{id:"env"} as never,sandbox:runtime,runtimeGeneration:"physical",workAuthority:{attempt:{workspaceId:"ws",sessionId:"session",executionId:"work",attemptId:"environment-work-claim:1",ownerId:"env",generation:1},holderHash:"a".repeat(64),isCurrent:async()=>true}});
 expect(published).toBe(true);
 expect(commands).toEqual([]);
});

import { configureNodeNativeStorage } from "../../../packages/control-plane-node/src/lib/work-finalization-host/native-storage.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access,readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
it("production Node native barrier drains actual queued rclone writes before canonical output publication",async()=>{
 const child=spawn("python3",[fileURLToPath(new URL("./node-native-rclone.fixture.py",import.meta.url))],{stdio:["pipe","pipe","pipe"]});
 let stderr="";child.stderr.on("data",b=>stderr+=b);const ended=new Promise(r=>child.on("exit",r));const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 try {
 const first=await lines.next();expect(first.done,stderr).toBe(false);const {remote}=JSON.parse(first.value!);await expect(access(remote+"/proof.txt")).rejects.toThrow();
 const runtime=new E2BSandboxExecutor({sandboxId:"physical",commands:{run:async(command,opts)=>{
   expect(opts?.user).toBe("root");expect(command).toContain('"remote":":s3:bucket/session-outputs/ws/session"');
   child.stdin.end(JSON.stringify({command})+"\n");const receipt=await lines.next();return {stdout:receipt.value!,stderr:"",exitCode:0};
 }},files:{read:async()=>"",write:async()=>{}},kill:async()=>{}} as any,{memoryBucket:{endpoint:"http://backend",accessKey:"unused",secretKey:"unused",bucketName:"bucket"}});
 configureNodeNativeStorage(runtime,{endpoint:"http://backend",accessKey:"unused",secretKey:"unused",bucketName:"bucket"});
 let published=false;
 const storage=createNodeSessionStorage({memoryStoreMode:"native",memories:()=>({}) as never,memoryBlobs:{} as never,outputs:{} as never,workOutputs:{synchronize:async()=>{expect(await readFile(remote+"/proof.txt","utf8")).toBe("physical-delayed-output");published=true;}},inputs:()=>({}) as never,isFenceActive:async()=>false,warn:()=>{}});
 await storage.synchronizeWork!({workspaceId:"ws",session:{id:"session",resources:[]} as never,environment:{id:"env"} as never,sandbox:runtime,runtimeGeneration:"physical",workAuthority:{attempt:{workspaceId:"ws",sessionId:"session",executionId:"work",attemptId:"environment-work-claim:1",ownerId:"env",generation:1},holderHash:"a".repeat(64),isCurrent:async()=>true}});
 expect(published).toBe(true);expect(JSON.parse((await lines.next()).value!)).toEqual({backend:"physical-delayed-output",queue:[]});expect(await ended,stderr).toBe(0);
 }finally{child.stdin.end();if(child.exitCode===null)child.kill("SIGTERM");}
});

it("Node native bootstrap installs RC rclone mounts and drain binds exact endpoint and Memory generation",async()=>{
 const commands:Array<{command:string;opts:any}>=[];
 const runtime=new E2BSandboxExecutor({sandboxId:"physical",commands:{run:async(command,opts)=>{commands.push({command,opts});return {stdout:command.includes("OMA_RCLONE_DRAIN_V1")?JSON.stringify({type:"drained",version:1}):"",stderr:"",exitCode:0};}},files:{read:async()=>"",write:async()=>{}},kill:async()=>{}} as any,{memoryBucket:{endpoint:"http://backend",accessKey:"secret-key",secretKey:"secret-value",bucketName:"bucket"}});
 configureNodeNativeStorage(runtime,{endpoint:"http://backend",accessKey:"secret-key",secretKey:"secret-value",bucketName:"bucket"});
 await runtime.mountSessionOutputs({tenantId:"ws",sessionId:"session"});
 await runtime.mountMemoryStore({storeName:"notes",storeId:".openma-managed-memory-workspaces/ws/session/physical/store/data",readOnly:false});
 expect(commands.filter(c=>c.command.includes("rclone mount"))).toHaveLength(2);
 for(const {command,opts} of commands.filter(c=>c.command.includes("rclone mount"))){expect(command).toContain("rclone mount");expect(command).toContain("--rc-addr=unix://");expect(command).not.toContain("secret-value");expect(opts.user).toBe("root");expect(opts.envs.RCLONE_S3_SECRET_ACCESS_KEY).toBe("secret-value");}
 const {drainNodeNativeWorkStorage}=await import("../../../packages/control-plane-node/src/lib/work-finalization-host/native-storage.js");
 await drainNodeNativeWorkStorage({workspaceId:"ws",session:{id:"session",resources:[{type:"memory_store",memoryStoreId:"store",name:"notes",access:"read_write"}]} as any,environment:{id:"env"} as any,sandbox:runtime,runtimeGeneration:"physical",workAuthority:{attempt:{} as any,isCurrent:async()=>true}});
 expect(commands.at(-1)!.command).toContain('"remote":":s3:bucket/.openma-managed-memory-workspaces/ws/session/physical/store/data"');
 expect(commands.at(-1)!.command).toContain('"endpoint":"http://backend"');
});

import { coldFixture } from "./node-cold-finalization.fixture.js";
import { coldProvider } from "./node-cold-finalization-provider.fixture.js";
import { nodeDefaults } from "../src/components.js";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime.js";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http.js";
import { Disposables } from "../../../packages/control-plane-node/src/lifecycle.js";
import { serve } from "@hono/node-server";
it("cold Node HTTP native drain -> actual archive -> canonical terminal waits for real rclone backend",async()=>{
 const f=await coldFixture();const child=spawn("python3",[fileURLToPath(new URL("./node-native-rclone.fixture.py",import.meta.url))],{stdio:["pipe","pipe","pipe"]});
 let stderr="";child.stderr.on("data",b=>stderr+=b);const ended=new Promise(r=>child.on("exit",r));const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const first=await lines.next();expect(first.done,stderr).toBe(false);const {remote}=JSON.parse(first.value!);
 const provider=await coldProvider(f,async command=>{child.stdin.end(JSON.stringify({command})+"\n");const receipt=await lines.next();expect(await readFile(remote+"/proof.txt","utf8")).toBe("physical-delayed-output");return receipt.value!;});
 const d=new Disposables();let server:ReturnType<typeof serve>|undefined;
 try{
  const b=await createNodeRuntime(await nodeDefaults(f.config,{sessionSandboxAdapter:provider.adapter}),d,{current:null});const app=await mountNodeHttp(b,d,b.workFinalizationHost);
  server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});if(!server.listening)await new Promise<void>(r=>server!.once("listening",r));
  await expect(access(remote+"/proof.txt")).rejects.toThrow();
  const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}${f.path}/work-finalize`,{method:"POST",headers:{authorization:"Bearer "+f.token,"content-type":"application/json"},body:JSON.stringify({turnId:f.turnId,revision:f.revision,stopReason:{type:"end_turn"}})});
  expect(response.status,await response.clone().text()).toBe(200);expect(await response.json()).toMatchObject({terminal:{stopReason:{type:"end_turn"}}});expect(await f.checkpoint()).not.toBeNull();expect(provider.operations).not.toContain("connect");
  expect(JSON.parse((await lines.next()).value!)).toMatchObject({queue:[]});expect(await ended,stderr).toBe(0);
 }finally{if(server)await new Promise<void>((r,j)=>server!.close(e=>e?j(e):r()));await d.dispose();await provider.close();child.stdin.end();if(child.exitCode===null)child.kill("SIGTERM");}
});
it("retained rclone mount validates and drains instead of remounting live queued writes",async()=>{
 const calls:string[]=[];
 const runtime=new E2BSandboxExecutor({sandboxId:"physical",commands:{run:async(command)=>{calls.push(command);return {stdout:command.includes("mountpoint")?"retained":JSON.stringify({type:"drained",version:1}),stderr:"",exitCode:0};}},files:{read:async()=>"",write:async()=>{}},kill:async()=>{}} as any,{memoryBucket:{endpoint:"http://backend",accessKey:"unused",secretKey:"unused",bucketName:"bucket"}});
 configureNodeNativeStorage(runtime,{endpoint:"http://backend",accessKey:"unused",secretKey:"unused",bucketName:"bucket"});
 await runtime.mountSessionOutputs({tenantId:"ws",sessionId:"session"});
 expect(calls.some(c=>c.includes("OMA_RCLONE_DRAIN_V1"))).toBe(true);
 expect(calls.some(c=>c.includes("--daemon --rc"))).toBe(false);
});
