import { readNodeWorkRuntime } from "../src/e2b-session-adapter.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createE2BV2Adapter, type E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import type { E2BSandboxLike } from "@open-managed-agents/sandbox-adapter-e2b";
import type { coldFixture } from "./node-cold-finalization.fixture.js";
import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";

/** E2B SDK boundary over a REAL loopback Files/Commands port. Shell and bytes
 * are real; root-private management protocol is emulated (not Linux/cloud
 * certification). No host/finalization/storage implementation is replaced. */
export async function coldProvider(f: Awaited<ReturnType<typeof coldFixture>>, drain?: (command:string)=>Promise<string>) {
  const physical = await f.sandbox.captureWork(environmentWorkSandboxTokenRef(f.claim));
  const runtime = physical.sandbox;
  const process = await runtime.startManagedProcess!({command: "/bin/sleep",args:["120"],env:{}});
  const locator = {sandboxId:"remote-exact",id:process.id,pid:process.pid,epoch:randomUUID(),
    identity:{workspaceId:"default",sessionId:f.session.id,workId:f.claim.workId,attemptId:"environment-work-claim:1"},
    holderHash:physical.workAuthority.holderHash!,status:"running"};
  const operations: string[]=[];
  const requests = new Map<string,string>();
  const map=(path:string)=>path.replaceAll("/tmp/","/oma/provider-tmp/");
  await runtime.writeFile(map("/tmp/.oma-warm"),physical.runtimeGeneration);
  const server=createServer(async(req,res)=>{
    try {
      const chunks: Buffer[]=[];for await(const c of req)chunks.push(c);
      const {op,path,data,command,id}=JSON.parse(Buffer.concat(chunks).toString()); operations.push(op);
      let value:unknown;
      if(op==="connect") {if(id!==locator.sandboxId)throw Error("unknown sandbox");value={sandboxId:id};}
      else if(op==="info") {if(id!==locator.sandboxId)throw Error("unknown sandbox");value={sandboxID:id,state:"running",lifecycle:{autoResume:false},envdVersion:"0.3.0",envdAccessToken:"test"};}
      else if(op==="run" && command.includes("OMA_RCLONE_DRAIN_V1")) {
        if(!command.includes('session-outputs/default/'+f.session.id))throw Error("wrong drain mount");
        value={stdout:drain?await drain(command):JSON.stringify({type:"drained",version:1}),stderr:"",exitCode:0};
      }
      else if(op==="run") {
        const output=await runtime.exec(map(command.replaceAll("base64 -w0 --", "base64 <")));
        value={stdout:output,stderr:"",exitCode:0};
      } else if(op==="read" && path.startsWith("/run/oma-managed/")) {
        value=path.endsWith("/ready")?"oma-managed-v2":requests.get(path);
        if(value===undefined)throw Error("management response missing");
      } else if(op==="write" && path.startsWith("/run/oma-managed/")) {
        requests.set(path,data);
        if(path.endsWith(".go")) {
          const prefix=path.slice(0,-3);const message=JSON.parse(requests.get(prefix+".json")!);
          let result:object;
          if(message.op==="inspect-slot")result={ok:true,locator};
          else if(message.op==="status") {
            const valid=message.target===locator.id && message.epoch===locator.epoch
              && JSON.stringify(message.identity)===JSON.stringify(locator.identity)
              && message.holderHash===locator.holderHash && message.sandboxId===locator.sandboxId;
            result=valid?{ok:true,status:locator.status}:{ok:false,error:"locator mismatch"};
          } else throw Error("cold recovery must never start/kill a process");
          requests.set(prefix+".response.json",JSON.stringify(result));
        }
        value=true;
      } else if(op==="read")value=await runtime.readFile(map(path));
      else if(op==="write")value=await runtime.writeFileBytes!(map(path),Buffer.from(data,"base64"));
      else throw Error("unexpected provider operation "+op);
      res.setHeader("content-type","application/json");res.end(JSON.stringify({value}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const rpc=async(body:object)=>{const r=await fetch(url,{method:"POST",body:JSON.stringify(body)});const x=await r.json() as any;if(!r.ok)throw Error(x.error);return x.value;};
  const client=(sandboxId:string):E2BSandboxLike=>({sandboxId,
      commands:{run:command=>rpc({op:"run",command})},files:{read:path=>rpc({op:"read",path}),write:(path,data)=>rpc({op:"write",path,data:path.startsWith("/run/oma-managed/")?data:Buffer.from(data).toString("base64")})},
      kill:async()=>{throw Error("must not kill runtime");}});
  const sdk={Sandbox:{connect:async(id:string):Promise<E2BSandboxLike>=>{
    const {sandboxId}=await rpc({op:"connect",id});return {sandboxId,
      commands:{run:command=>rpc({op:"run",command})},files:{read:path=>rpc({op:"read",path}),write:(path,data)=>rpc({op:"write",path,data:path.startsWith("/run/oma-managed/")?data:Buffer.from(data).toString("base64")})},
      kill:async()=>{throw Error("must not kill runtime");},setTimeout:async()=>{operations.push("renew");},getInfo:async()=>({state:"running"})};
  },create:async()=>{operations.push("create");throw Error("must not allocate");}}} as unknown as E2BV2Module;
  const adapter=createE2BV2Adapter({sdk,connection:{},leaseMs:1200000,maxLifetimeMs:3600000,managedBootstrap:{},
    // Declares a pre-existing native mount; no mount/attach is performed during reconnect.
    memoryBucket:{endpoint:"http://unused.invalid",accessKey:"unused",secretKey:"unused",bucketName:"unused"}});
  const key="session_sandbox_state:"+f.session.id;
  const row=(await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?').bind("default",key).first<{value:string}>())!;
  const state=JSON.parse(row.value);state.handle={provider:"e2b",runtimeId:locator.sandboxId};
  await f.sql.prepare('UPDATE kv_entries SET value=? WHERE tenant_id=? AND "key"=?').bind(JSON.stringify(state),"default",key).run();
  const readonlySdk={ApiClient:class{api={GET:async(_path:string,input:any)=>({data:await rpc({op:"info",id:input.params.path.sandboxID})})};},ConnectionConfig:class{},Sandbox:class{constructor(options:any){Object.assign(this,client(options.sandboxId));}}} as unknown as Parameters<typeof readNodeWorkRuntime>[0];
  return {locator,operations,adapter:{adapter,image:()=>"unused",keepAliveMs:300000,
    nativeWorkBucket:{endpoint:"http://unused.invalid",accessKey:"unused",secretKey:"unused",bucketName:"unused"},
    connectWorkReadonly:(id:string)=>readNodeWorkRuntime(readonlySdk,{memoryBucket:{endpoint:"http://unused.invalid",accessKey:"unused",secretKey:"unused",bucketName:"unused"}},id)},
    async close(){await process.kill("SIGKILL");await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
