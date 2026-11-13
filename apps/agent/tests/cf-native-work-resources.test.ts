// Local workerd/D1/R2 evidence only. The IO boundary is a fixture, not FUSE.
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { synchronizeNativeWorkStorage } from "../../main/src/lib/cf-native-work-storage";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
function input(resource: object) {
 const claim = { workspaceId: "default", sessionId: "native-resource-local", environmentId: "environment", workId: "work", generation: 1, holder: "holder" };
 const mounts = [{ mountPath: "/mnt/session/outputs", keyPrefix: sessionOutputsPrefix(claim.workspaceId,claim.sessionId).replace(/\/$/, ""), access: "read-write" }, { mountPath: "/mnt/memory/project-notes", keyPrefix: `.openma-managed-memory-snapshots/default/store/${"a".repeat(64)}`, access: "read-only" }];
 return {env, sql: new CfD1SqlClient(env.MAIN_DB!), claim, session: { resources: [resource] }, process: { ...claim, epoch: "epoch", mounts }, fence: {}, authorize: async () => true, runtime: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readBytes: async () => new Uint8Array(), readFile: async () => "", writeFileBytes: async () => {} } } as unknown as Parameters<typeof synchronizeNativeWorkStorage>[0];
}
it("reconciles the published path of a read-only store whose display name contains spaces", async () => {
 await expect(synchronizeNativeWorkStorage(input({type:"memory_store", memoryStoreId:"store", name:"Project Notes", mountPath:"/mnt/memory/project-notes", access:"read_only"}))).resolves.toBeUndefined();
});
it("requires a generation baseline when access is omitted (the Work read-write default)", async () => {
 await expect(synchronizeNativeWorkStorage(input({type:"memory_store", memoryStoreId:"store", name:"project-notes", mountPath:"/mnt/memory/project-notes"}))).rejects.toThrow("Work Memory mount baseline is missing");
});

import { afterEach } from "vitest";
import { prepareNativeWorkStorage } from "../../main/src/lib/cf-native-work-storage";
import { CloudflareSandbox, setCloudflareSandboxForTest } from "../src/runtime/sandbox";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { SqlSessionSource } from "@open-managed-agents/managed-agents-adapters-sql";
import type { OmaMountBucketRequest } from "../src/oma-sandbox";
afterEach(() => setCloudflareSandboxForTest(undefined));
async function bootstrapFixture(access?: "read_only" | "read_write") {
 const sql = new CfD1SqlClient(env.MAIN_DB!), sessionId = "native_"+crypto.randomUUID(), storeId = "store_"+crypto.randomUUID();
 await seedSandboxGatewaySessionRows(sql,"default",{ id:sessionId,environmentId:"env_"+crypto.randomUUID(),vaultIds:[],agent:{id:"agent",version:1},archivedAt:null });
 const now = new Date().toISOString();
 await sql.prepare("INSERT INTO managed_memory_stores VALUES ('default',?,?,1,?,?,NULL)").bind(storeId,JSON.stringify({id:storeId,name:"Project Notes",description:null,metadata:{},createdAt:now,updatedAt:now,archivedAt:null}),Date.now(),Date.now()).run();
 const resource={type:"memory_store",memoryStoreId:storeId,name:"Project Notes",mountPath:"/mnt/memory/project-notes",...(access?{access}:{})};
 await sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.resources',json(?)) WHERE id=?").bind(JSON.stringify([resource]),sessionId).run();
 const physical = { incarnation:"native-epoch", mounts:[] as OmaMountBucketRequest[], pending:[] as string[], fail:false, running:false,
  async describe(){return {running:this.running,incarnation:this.running?this.incarnation:null,mounts:this.mounts.map(m=>m.mountPath)};},
  async provision(request:{incarnation:string;mounts:OmaMountBucketRequest[]}) {if(this.fail)throw Error("fixture mount attach failed");this.incarnation=request.incarnation;this.mounts=request.mounts;this.running=true;return {incarnation:this.incarnation,started:true,pendingMounts:this.pending};},
 };
 setCloudflareSandboxForTest(physical as never);
 const configured={...env,MEMORY_BUCKET_NAME:"memory",FILES_BUCKET_NAME:"files",R2_ENDPOINT:"https://local.invalid",R2_ACCESS_KEY_ID:"fixture",R2_SECRET_ACCESS_KEY:"fixture"};
 const runtime = new CloudflareSandbox(configured as never,sessionId);
 const scope={workspaceId:"default",sessionId};
 const preparation={env:configured,sql,scope,runtime,assertCurrent:async()=>{}};
 return {sql,scope,resource,storeId,physical,configured,runtime,preparation};
}
it("bootstraps omitted-access canonical Memory at its published path and reconciles R2 bytes under the same physical generation",async()=>{
 const f=await bootstrapFixture();
 const prepared=await prepareNativeWorkStorage(f.preparation);
 const mount=prepared.mounts.find(m=>m.mountPath===f.resource.mountPath)!;
 expect(mount.options.readOnly).toBe(false);
 const prefix=mount.options.prefix!.replace(/^\/+|\/+$/g,"");
 expect(prefix).toBe(`.openma-managed-memory-workspaces/default/${f.scope.sessionId}/${prepared.incarnation}/${f.storeId}/data`);
 expect(await env.MEMORY_BUCKET!.get(prefix.replace(/data$/,"manifest.json"))).not.toBeNull();
 // Fixture provider write through the exact requested mount into real local R2.
 await env.MEMORY_BUCKET!.put(prefix+"/notes.md","independently persisted native bytes");
 let flushed=false;
 const data={...input(f.resource),env:f.configured,sql:f.sql,claim:{...input(f.resource).claim,...f.scope},session:(await new SqlSessionSource(f.sql).find(f.scope))!,process:{...input(f.resource).process,epoch:prepared.incarnation,mounts:prepared.mounts.map(m=>({mountPath:m.mountPath,keyPrefix:m.options.prefix!.replace(/^\/+|\/+$/g,""),access:m.options.readOnly?"read-only" as const:"read-write" as const}))}};
 data.runtime.run=async(command)=>{expect(command).toContain(f.resource.mountPath);flushed=true;return {exitCode:0,stdout:"",stderr:""};};
 await synchronizeNativeWorkStorage(data);
 expect(flushed).toBe(true);
 const rows=await f.sql.prepare("SELECT document FROM managed_memories WHERE memory_store_id=?").bind(f.storeId).all<{document:string}>();
 expect(rows.results!.map(r=>JSON.parse(r.document))).toMatchObject([{path:"/notes.md",content:"independently persisted native bytes"}]);
 // A warm dispatch keeps unsynchronized edits and the baseline, never reprojects.
 await env.MEMORY_BUCKET!.put(prefix+"/notes.md","unsynchronized next turn");
 const again=await prepareNativeWorkStorage(f.preparation);
 expect(again.incarnation).toBe(prepared.incarnation);
 expect(await (await env.MEMORY_BUCKET!.get(prefix+"/notes.md"))!.text()).toBe("unsynchronized next turn");
 await expect(synchronizeNativeWorkStorage({...data,process:{...data.process,epoch:"different-generation"}})).rejects.toThrow("baseline is missing");
 await expect(synchronizeNativeWorkStorage({...data,process:{...data.process,mounts:[]}})).rejects.toThrow("Native Memory mount mismatch");
 await expect(synchronizeNativeWorkStorage({...data,process:{...data.process,mounts:data.process.mounts.map(m=>m.mountPath===f.resource.mountPath?{...m,access:"read-only"}:m)}})).rejects.toThrow("Native Memory mount mismatch");
});
it("bootstraps read-only snapshots at canonical paths and rejects a writable mount for them",async()=>{
 const f=await bootstrapFixture("read_only"),prepared=await prepareNativeWorkStorage(f.preparation);
 const mount=prepared.mounts.find(m=>m.mountPath===f.resource.mountPath)!;
 expect(mount.options.readOnly).toBe(true);
 expect(mount.options.prefix).toMatch(new RegExp(`^/\\.openma-managed-memory-snapshots/default/${f.storeId}/[a-f0-9]{64}/$`));
 const data={...input(f.resource),env:f.configured,sql:f.sql,claim:{...input(f.resource).claim,...f.scope},session:(await new SqlSessionSource(f.sql).find(f.scope))!,process:{...input(f.resource).process,epoch:prepared.incarnation,mounts:prepared.mounts.map(m=>({mountPath:m.mountPath,keyPrefix:m.options.prefix!.replace(/^\/+|\/+$/g,""),access:m.options.readOnly?"read-only" as const:"read-write" as const}))}};
 await synchronizeNativeWorkStorage(data);
 await expect(synchronizeNativeWorkStorage({...data,process:{...data.process,mounts:data.process.mounts.map(m=>({...m,access:"read-write"}))}})).rejects.toThrow("Native Memory mount mismatch");
});
it.each(["missing-config","mount-failed","mount-pending","generation-changed","authority-lost"])("refuses native bootstrap: %s",async failure=>{
 const f=await bootstrapFixture();
 if(failure==="missing-config")f.configured.R2_ENDPOINT="";
 if(failure==="mount-failed")f.physical.fail=true;
 if(failure==="mount-pending")f.physical.pending=[f.resource.mountPath];
 if(failure==="generation-changed") {const provision=f.physical.provision.bind(f.physical);f.physical.provision=async request=>({...await provision(request),incarnation:"replacement"});}
 if(failure==="authority-lost")f.preparation.assertCurrent=async()=>{throw Error("claim lost");};
 await expect(prepareNativeWorkStorage(f.preparation)).rejects.toThrow();
});

import { dispatchCfWorkRunnerRequest } from "../src/runtime/cf-work-runner-entry";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
it.each(["read_write","read_only","omitted","missing-config","failed-mount"])("reachable HTTP native bootstrap enforces canonical resources before launch: %s",async mode=>{
 const f=await bootstrapFixture(mode==="read_only"?"read_only":mode==="read_write"?"read_write":undefined);
 const session=(await new SqlSessionSource(f.sql).find(f.scope))!;
 const root="native-http-root-012345678901234567890",workId="work_"+crypto.randomUUID(),now=new Date().toISOString();
 const agent={...session.agent,openma:{harness:"acp-sandbox",acp:{agent:{command:"/opt/agents/local-fixture"}}}};
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.agent',json(?)) WHERE id=?").bind(JSON.stringify(agent),f.scope.sessionId).run();
 const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret");
 const work=new SqlEnvironmentWorkStore(f.sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 const token="sk-ant-req-v1.local-transport-only";
 await work.insert({workspaceId:"default",record:{work:{id:workId,environmentId:session.environmentId,data:{type:"session",id:session.id},state:"queued",createdAt:now,metadata:{},acknowledgedAt:null,latestHeartbeatAt:null,startedAt:null,stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:1,claimedAt:now,workerId:"local-owner"},heartbeatTtlSeconds:90}});
 let starts=0,preparationCommands=0;
 Object.assign(f.physical,{
  async exec(){preparationCommands++;return {exitCode:0,stdout:"",stderr:""};},
  async setOutboundHandler(){},async setOutboundByHost(){},async restrictOutboundToHosts(){},
  async startProcess(){throw Error("native cannot fall back to generic process launch");},
  async startNativeWorkProcess(_command:string,_environment:unknown,resources:{incarnation:string;mounts:OmaMountBucketRequest[]}){
   expect(resources.incarnation).toBe(f.physical.incarnation);
   expect(resources.mounts).toEqual(f.physical.mounts);
   const memory=resources.mounts.find(m=>m.mountPath===f.resource.mountPath)!;
   expect(memory).toBeDefined();expect(memory.options.readOnly).toBe(mode==="read_only");
   const prefix=memory.options.prefix!.replace(/^\/+|\/+$/g,"");
   if(mode!=="read_only")expect(await env.MEMORY_BUCKET!.get(prefix.replace(/data$/,"manifest.json"))).not.toBeNull();
   starts++;return {id:"fixture-process",pid:42,async kill(){},async getStatus(){return "running";}};
  },
 });
 if(mode==="missing-config")f.configured.R2_ENDPOINT="";
 if(mode==="failed-mount")f.physical.fail=true;
 const delivery={...f.scope,environmentId:session.environmentId,workId,apiBaseUrl:"https://control.test",workSecret:btoa(JSON.stringify({sessions_token:token,api_base_url:"https://control.test",claim_generation:1}))};
 const response=await dispatchCfWorkRunnerRequest(new Request("https://agent.test/__internal/work/dispatch",{method:"POST",body:JSON.stringify(delivery)}),{...f.configured,PLATFORM_ROOT_SECRET:root,PUBLIC_BASE_URL:"https://control.test",OPENMA_WORK_RUNNER_COMMAND:"/opt/oma/local-fixture",OPENMA_ACP_HARNESSES:JSON.stringify([{id:"local-fixture",version:"1.0.0",command:"/opt/agents/local-fixture"}])} as never);
 expect(response.status,await response.clone().text()).toBe(mode==="missing-config"||mode==="failed-mount"?409:200);
 expect(starts).toBe(mode==="missing-config"||mode==="failed-mount"?0:1);
 if(starts===0)expect(preparationCommands).toBe(0);
});

it.each(["valid", "expired", "invalid", "restore-failed", "generation-changed"])("native Work workspace restore is mandatory before launch: %s", async mode => {
 const f = await bootstrapFixture();
 const session = (await new SqlSessionSource(f.sql).find(f.scope))!;
 const handle = { id: "local-checkpoint", dir: "/workspace", size: 42, sha256: "a".repeat(64), format: "tar+zstd/1" };
 const now = Date.now();
 await f.sql.prepare("INSERT INTO workspace_backups(tenant_id,environment_id,source_session_id,backup_handle,created_at,expires_at) VALUES(?,?,?,?,?,?)")
  .bind(f.scope.workspaceId, session.environmentId, f.scope.sessionId, JSON.stringify(mode === "invalid" ? {...handle,sha256:"bad"} : handle), now, mode === "expired" ? now-1 : now+60000).run();
 let restores = 0;
 Object.assign(f.physical, { async restoreBackup(received: unknown) {
  restores++;expect(received).toEqual(handle);
  if (mode === "restore-failed") throw Error("fixture archive unavailable");
  if (mode === "generation-changed") f.physical.incarnation = "replaced-during-restore";
  return { success: true };
 } });
 console.log(JSON.stringify({op:"native.workspace.restore_gate",mode}));
 if (mode === "valid") {await prepareNativeWorkStorage(f.preparation);expect(restores).toBe(1);}
 else {
  await expect(prepareNativeWorkStorage(f.preparation)).rejects.toThrow(mode === "generation-changed" ? "generation changed" : mode === "restore-failed" ? "restore failed" : "checkpoint unavailable or invalid");
  if (mode === "restore-failed") {
   // Provisioning succeeded before restore failed. A warm retry must not
   // silently turn the failed cold restoration into an empty successful start.
   await expect(prepareNativeWorkStorage(f.preparation)).rejects.toThrow("restore failed");
   expect(restores).toBe(2);
  }
  if (mode === "expired" || mode === "invalid") expect(restores).toBe(0);
 }
});
