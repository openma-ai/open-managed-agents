import { workStorageContext } from "./work-storage-fixture.js";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryBlobStore, type BlobStore } from "@open-managed-agents/blob-store";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { NodeManagedSessionOutputCollector } from "../../../packages/control-plane-node/src/lib/node-managed-session-outputs.js";
import { NodeSharedSessionOutputs } from "../../../packages/control-plane-node/src/lib/node-shared-session-outputs.js";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess.js";
import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";
import type { NodeWorkStorageInput } from "../../../packages/control-plane-node/src/lib/node-session-sandbox.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const holderHash = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".test-artifacts/work-output-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec("CREATE TABLE managed_environment_work (workspace_id TEXT, environment_id TEXT, id TEXT, session_id TEXT, claim_generation INTEGER, claim_at INTEGER, heartbeat_ttl_seconds INTEGER, state TEXT, sandbox_token_hashes TEXT, revision INTEGER)");
  await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','env','work','sess',1,?,90,'active',?,1)").bind(Date.now(), JSON.stringify([{h:holderHash,s:"all"}])).run();
  const stored = new InMemoryBlobStore(); let beforePut: (() => Promise<void>) | undefined;
  const blobs: BlobStore = { get: key => stored.get(key), head: key => stored.head(key), delete: key => stored.delete(key), put: async (key, value, options) => { if (key.endsWith("/manifest.json")) await beforePut?.(); return stored.put(key, value, options); } };
  const shared = new NodeSharedSessionOutputs({ sql, blobs }); await shared.ensureSchema();
  const reader = new NodeSharedSessionOutputs({ sql, blobs });
  const sandbox: Omit<LocalSubprocessSandbox, "sessionOutputMountCapabilities"> & {
    sessionOutputMountCapabilities(): { durability: "durable" | "best_effort" } | null;
  } = new LocalSubprocessSandbox({ workdir: join(root, "sandbox"), outputsRoot: join(root, "local") });
  cleanup.push(() => sandbox.destroy());
  // The local adapter rewrites /mnt paths to host paths (not a VM namespace).
  // Normalize only its manifest stdout; enumeration and byte reads remain real.
  const exec = sandbox.exec.bind(sandbox);
  sandbox.exec = async (command, timeout) => {
    const result = await exec(command, timeout);
    const begin = "__OPENMA_OUTPUT_MANIFEST_BEGIN__", end = "__OPENMA_OUTPUT_MANIFEST_END__";
    if (!command.includes(begin)) return result;
    const start = result.indexOf(begin) + begin.length, finish = result.indexOf(end);
    const paths = Buffer.from(result.slice(start, finish), "base64").toString().replaceAll(join(root, "sandbox/.mnt/session/outputs"), "/mnt/session/outputs");
    return result.slice(0, start) + Buffer.from(paths).toString("base64") + result.slice(finish);
  };
  await sandbox.exec("mkdir -p /mnt/session/outputs"); await sandbox.writeFile("/mnt/session/outputs/report.txt", "real Work bytes");
  await shared.restoreToSandbox("ws", "sess", sandbox, "physical-1");
  const workAuthority = { attempt: environmentWorkSandboxTokenRef({workspaceId:"ws",environmentId:"env",workId:"work",sessionId:"sess",generation:1}), holderHash, isCurrent: async () => true };
  const input = { ...workStorageContext(),sandbox,runtimeGeneration:"physical-1",workAuthority } as NodeWorkStorageInput;
  const collector = new NodeManagedSessionOutputCollector({outputsRoot:root,isFenceActive:async()=>{throw new Error("MA fence must not be used");},shared});
  const read = async () => { const item = await reader.read("ws","sess","report.txt");return item ? new Response(item.body).text() : null; };
  return {root,sql,shared,reader,sandbox,input,collector,read,hook:(fn:()=>Promise<void>)=>{beforePut=fn;}};
}
it("collects real Work sandbox bytes and reads them through the public output store without any MA row",async()=>{
 const f=await fixture();await f.collector.synchronizeWork(f.input);
 expect((await f.reader.list("ws","sess")).map(f=>f.filename)).toEqual(["report.txt"]);expect(await f.read()).toBe("real Work bytes");
});
it.each(["generation","ttl","holder","stopped"] as const)("rejects %s loss after upload began without replacing canonical bytes",async mode=>{
 const f=await fixture();await f.collector.synchronizeWork(f.input);await f.sandbox.writeFile("/mnt/session/outputs/report.txt","stale bytes");
 f.hook(async()=>{await f.sql.exec(mode==="generation"?"UPDATE managed_environment_work SET claim_generation = 2":mode==="ttl"?"UPDATE managed_environment_work SET claim_at = 0":mode==="holder"?"UPDATE managed_environment_work SET sandbox_token_hashes = '[]'":"UPDATE managed_environment_work SET state = 'stopped'");});
 await expect(f.collector.synchronizeWork(f.input)).rejects.toThrow(/claim|fence|pointer/);expect(await f.read()).toBe("real Work bytes");
});
it("does not let a delayed old publication borrow the newly hydrated owner's base",async()=>{
 const f=await fixture();await f.collector.synchronizeWork(f.input);await f.sandbox.writeFile("/mnt/session/outputs/report.txt","old upload");
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});let first=true;
 f.hook(async()=>{if(first){first=false;entered();await gate;}});
 const old=f.collector.synchronizeWork(f.input);const rejected=expect(old).rejects.toThrow(/claim|fence|pointer/);await started;
 // Same physical generation, separate live owner/hydration; old upload keeps its original expected pointer.
 await f.shared.restoreToSandbox("ws","sess",f.sandbox,"physical-1");await f.sandbox.writeFile("/mnt/session/outputs/report.txt","new owner bytes");
 await f.collector.synchronizeWork(f.input);release();await rejected;expect(await f.read()).toBe("new owner bytes");
});
it("requires the actual holder and a hydrated Work output base",async()=>{
 const f=await fixture();await expect(f.collector.synchronizeWork({...f.input,workAuthority:{...f.input.workAuthority,holderHash:undefined}})).rejects.toThrow(/holder/);
 await expect(f.collector.synchronizeWork({...f.input,runtimeGeneration:"unhydrated"})).rejects.toThrow(/hydrated/);expect(await f.read()).toBeNull();
});

it.each(["shared", "local"] as const)("serves real %s Work collector output through the official HTTP outputs API",async mode=>{
 const {loadNodeConfig}=await import("../src/config.js");
 const {nodeDefaults,createMemoryBlobs}=await import("../src/components.js");
 const {createNodeControlPlane}=await import("../src/control-plane.js");
 const {SqlEnvironmentWorkStore}=await import("../../../packages/environment-work-store-sql/src/index.js");
 const root=await mkdtemp(join(process.cwd(),".test-artifacts/work-output-api-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"1",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled",...(mode==="shared"?{FILES_S3_ENDPOINT:"http://unused.invalid",FILES_S3_BUCKET:"test",FILES_S3_ACCESS_KEY:"test",FILES_S3_SECRET_KEY:"test"}:{})});
 const blobs=new InMemoryBlobStore();const components=await nodeDefaults(config,{blobs:{files:{store:blobs,description:"test shared"},memory:await createMemoryBlobs(config.blobs.memory)}});
 const cp=await createNodeControlPlane(components);cleanup.push(()=>cp.stop("test"));
 const post=async(path:string,body:unknown)=>{const response=await cp.fetch(new Request("http://local"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));expect(response.status,await response.clone().text()).toBeLessThan(300);return await response.json() as any;};
 const env=await post("/v1/environments",{name:"output",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await post("/v1/agents",{name:"output",model:"test"});const session=await post("/v1/sessions",{agent:agent.id,environment_id:env.id});
 const sql=components.database.sql;const work=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:plaintext}),open:async({ciphertext})=>({plaintext:ciphertext})});
 const now=new Date().toISOString();await work.insert({workspaceId:"default",record:{work:{id:"work-output",environmentId:env.id,data:{type:"session",id:session.id},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:"test"},claim:{generation:1,workerId:"test",claimedAt:now},heartbeatTtlSeconds:90}});
 await sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes = ? WHERE id = ?").bind(JSON.stringify([{h:holderHash,s:"all"}]),"work-output").run();
 const shared=new NodeSharedSessionOutputs({sql,blobs});
 const sandbox={sessionOutputMountCapabilities:()=>({durability:"best_effort" as const}),exec:async()=>Buffer.from("/mnt/session/outputs/report.txt\0").toString("base64"),readFileBytes:async()=>new TextEncoder().encode("Work output via HTTP"),readFile:async()=>"",writeFile:async()=>""};
 if(mode==="shared")await shared.restoreToSandbox("default",session.id,sandbox,"physical-api");
 const collector=new NodeManagedSessionOutputCollector({outputsRoot:join(root,"outputs"),isFenceActive:async()=>{throw new Error("no MA fence");},...(mode==="shared"?{shared}:{})});
 await collector.synchronizeWork({workspaceId:"default",session,environment:workStorageContext().environment,sandbox,runtimeGeneration:"physical-api",workAuthority:{attempt:environmentWorkSandboxTokenRef({workspaceId:"default",environmentId:env.id,sessionId:session.id,workId:"work-output",generation:1}),holderHash,isCurrent:async()=>true}});
 const list=await cp.fetch(new Request("http://local/v1/sessions/"+session.id+"/outputs"));expect(list.status).toBe(200);expect((await list.json() as any).data.map((x:any)=>x.filename)).toEqual(["report.txt"]);
 const read=await cp.fetch(new Request("http://local/v1/sessions/"+session.id+"/outputs/report.txt"));expect(read.status).toBe(200);expect(await read.text()).toBe("Work output via HTTP");
 expect(await sql.prepare("SELECT COUNT(*) AS count FROM managed_session_executions").first()).toEqual({count:0});
});

it("does not garbage-collect an uploading candidate while its Work claim is alive",async()=>{
 const f=await fixture();const {ensureSessionExecutionCoordinatorSchema}=await import("../../../packages/session-runtime-sql/src/index.js");await ensureSessionExecutionCoordinatorSchema(f.sql);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 f.hook(async()=>{entered();await gate;});const publishing=f.collector.synchronizeWork(f.input);void publishing.catch(()=>{});await started;
 try { expect(await f.reader.collectGarbage({beforeMs:Date.now()+1000})).toBe(0); }
 finally {release();}
 await publishing;expect(await f.read()).toBe("real Work bytes");
});
// main-compatible local publication: durable mounts and staging/rename.
// SQL authority checks are not atomic with filesystem publication.
it("main parity: Work preserves local durable outputs without requiring shared storage",async()=>{
 const f=await fixture();f.sandbox.sessionOutputMountCapabilities=()=>({durability:"durable"});
 const collector=new NodeManagedSessionOutputCollector({outputsRoot:f.root,isFenceActive:async()=>true});
 const executionFence={...f.input.workAuthority.attempt,expiresAt:"2999-01-01T00:00:00Z"};
 await expect(collector.synchronize({workspaceId:"ws",sessionId:"sess",sandbox:f.sandbox,executionFence})).resolves.toBeUndefined();
 await expect(collector.synchronizeWork(f.input)).resolves.toBeUndefined();
 expect(await f.sandbox.readFile("/mnt/session/outputs/report.txt")).toBe("real Work bytes");
});
it("main parity: Work collects best-effort local outputs using the existing durable directory",async()=>{
 const f=await fixture();f.sandbox.sessionOutputMountCapabilities=()=>({durability:"best_effort"});
 const ma=new NodeManagedSessionOutputCollector({outputsRoot:join(f.root,"ma"),isFenceActive:async()=>true});
 await ma.synchronize({workspaceId:"ws",sessionId:"sess",sandbox:f.sandbox,executionFence:{...f.input.workAuthority.attempt,expiresAt:"2999-01-01T00:00:00Z"}});
 expect(await readFile(join(f.root,"ma/ws/sess/report.txt"),"utf8")).toBe("real Work bytes");
 const work=new NodeManagedSessionOutputCollector({outputsRoot:join(f.root,"work"),isFenceActive:async()=>{throw new Error("Work must not use MA authority");}});
 await expect(work.synchronizeWork(f.input)).resolves.toBeUndefined();
 expect(await readFile(join(f.root,"work/ws/sess/report.txt"),"utf8")).toBe("real Work bytes");
});

it("rechecks the holder inside publication CAS after the preflight read succeeded",async()=>{
 const f=await fixture();await f.collector.synchronizeWork(f.input);await f.sandbox.writeFile("/mnt/session/outputs/report.txt","late stale bytes");
 const batch=f.sql.batch.bind(f.sql);let raced=false;
 f.sql.batch=async statements=>{if(!raced){raced=true;await f.sql.exec("UPDATE managed_environment_work SET sandbox_token_hashes = '[]'");}return batch(statements);};
 await expect(f.collector.synchronizeWork(f.input)).rejects.toThrow(/fence|pointer/);
 expect(raced).toBe(true);expect(await f.read()).toBe("real Work bytes");
});
it("reclaims an expired Work upload candidate without changing canonical outputs",async()=>{
 const f=await fixture();const {ensureSessionExecutionCoordinatorSchema}=await import("../../../packages/session-runtime-sql/src/index.js");await ensureSessionExecutionCoordinatorSchema(f.sql);
 await f.collector.synchronizeWork(f.input);await f.sandbox.writeFile("/mnt/session/outputs/report.txt","uncommitted");
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 f.hook(async()=>{entered();await gate;});const pending=f.collector.synchronizeWork(f.input);const rejected=expect(pending).rejects.toThrow(/fence|pointer|claim/);await started;
 try {await f.sql.exec("UPDATE managed_environment_work SET claim_at = 0");expect(await f.reader.collectGarbage({beforeMs:Date.now()+1000})).toBe(1);}
 finally {release();}
 await rejected;expect(await f.read()).toBe("real Work bytes");
});

it.each(["claim", "read"] as const)("local Work %s failure during staging preserves the previous output",async fault=>{
 const f=await fixture();f.sandbox.sessionOutputMountCapabilities=()=>({durability:"best_effort"});
 const root=join(f.root,"local-publish");const collector=new NodeManagedSessionOutputCollector({outputsRoot:root,isFenceActive:async()=>true});
 // Seed with the unchanged MA path, so the test reaches the failing Work phase
 // even before local Work publication exists.
 await collector.synchronize({workspaceId:"ws",sessionId:"sess",sandbox:f.sandbox,executionFence:{...f.input.workAuthority.attempt,expiresAt:"2999-01-01T00:00:00Z"}});
 await f.sandbox.writeFile("/mnt/session/outputs/report.txt","uncommitted bytes");
 let current=true,read=false;f.input.workAuthority.isCurrent=async()=>current;
 const readBytes=f.sandbox.readFileBytes.bind(f.sandbox);
 f.sandbox.readFileBytes=async path=>{read=true;if(fault==="read")throw new Error("injected read failure");const bytes=await readBytes(path);current=false;return bytes;};
 await expect(collector.synchronizeWork(f.input)).rejects.toThrow(fault==="read"?/injected read failure/:/claim/);
 expect(read).toBe(true);expect(await readFile(join(root,"ws/sess/report.txt"),"utf8")).toBe("real Work bytes");
});
it("a stale local Work cannot replace outputs already published by its successor",async()=>{
 const f=await fixture();f.sandbox.sessionOutputMountCapabilities=()=>({durability:"best_effort"});
 const root=join(f.root,"handoff");const collector=new NodeManagedSessionOutputCollector({outputsRoot:root,isFenceActive:async()=>true});
 await collector.synchronize({workspaceId:"ws",sessionId:"sess",sandbox:f.sandbox,executionFence:{...f.input.workAuthority.attempt,expiresAt:"2999-01-01T00:00:00Z"}});
 let current=true;f.input.workAuthority.isCurrent=async()=>current;
 const oldInput={...f.input,sandbox:{exec:f.sandbox.exec.bind(f.sandbox),readFile:f.sandbox.readFile.bind(f.sandbox),writeFile:f.sandbox.writeFile.bind(f.sandbox),sessionOutputMountCapabilities:()=>({durability:"best_effort" as const}),readFileBytes:async()=>{
   current=false;
   await f.sandbox.writeFile("/mnt/session/outputs/report.txt","successor bytes");
   await collector.synchronizeWork({...f.input,workAuthority:{...f.input.workAuthority,attempt:{...f.input.workAuthority.attempt,generation:2,attemptId:"environment-work-claim:2"},isCurrent:async()=>true}});
   return new TextEncoder().encode("stale bytes");
 }}};
 await expect(collector.synchronizeWork(oldInput)).rejects.toThrow(/claim/);
 expect(await readFile(join(root,"ws/sess/report.txt"),"utf8")).toBe("successor bytes");
});

// Real Work-row authorization, native Memory reconciliation, sandbox facade,
// collector and canonical output reader. The provider checkpoint is the only
// simulated infrastructure. This is NOT the supervisor/terminal wiring test.
it.each(["local", "shared"] as const)("composes %s Memory/output barrier before checkpoint and preserves ownership on sync failure", async mode => {
  const { createHash } = await import("node:crypto");
  const { MemoriesApplicationService } = await import("../../../packages/managed-agents-application/src/memories/application.js");
  const { InMemoryMemoryDocumentStore } = await import("../../../packages/memory-document-store-memory/src/index.js");
  const { ManagedMemorySnapshotMaterializer } = await import("@open-managed-agents/managed-agents-adapters-runtime");
  const { createNodeSessionStorage } = await import("../../../packages/control-plane-node/src/lib/node-session-storage.js");
  const { NodeSessionSandboxes } = await import("../../../packages/control-plane-node/src/lib/node-session-sandbox.js");
  const { fromV1SandboxFactory } = await import("../../../packages/sandbox-port-kit/src/v1-bridge.js");
  const f = await fixture();
  const order: string[] = [];
  const memoryStore = new InMemoryMemoryDocumentStore();
  const memories = new MemoriesApplicationService({ workspaceId: "ws", store: memoryStore,
    memoryStores: { find: async () => ({ id: "store", name: "notes", archivedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }) },
    content: { describe: async ({content}) => ({ sha256: createHash("sha256").update(content ?? "").digest("hex"), sizeBytes: Buffer.byteLength(content ?? "") }) },
    actor: {kind:"session",sessionId:"sess"}, clock: { now: () => new Date() }, ids: { nextMemoryId: () => crypto.randomUUID(), nextMemoryVersionId: () => crypto.randomUUID() },
  });
  const memoryBytes = new Map<string, string>();
  const memoryBlobs = { getText: async (key:string) => memoryBytes.get(key) ?? null, put: async (key:string,value:string) => { memoryBytes.set(key,value); return {}; }, delete: async (key:string) => {memoryBytes.delete(key);}, list: async (prefix:string) => ({keys:[...memoryBytes.keys()].filter(key=>key.startsWith(prefix)),nextCursor:null}) };
  const outputsRoot = join(f.root,"combined");
  f.sandbox.sessionOutputMountCapabilities = () => ({durability:"best_effort"});
  const collector = new NodeManagedSessionOutputCollector({outputsRoot,isFenceActive:async()=>{throw Error("MA fence used");},...(mode==="shared"?{shared:f.shared}:{})});
  // This is the host's actual Work authority boundary, not an always-true test fence.
  const isCurrent = async () => Boolean(await f.sql.prepare("SELECT 1 FROM managed_environment_work WHERE workspace_id='ws' AND environment_id='env' AND session_id='sess' AND id='work' AND claim_generation=1 AND claim_at + heartbeat_ttl_seconds * 1000 > ? AND state IN ('active','stopping') AND sandbox_token_hashes=?").bind(Date.now(),JSON.stringify([{h:holderHash,s:"all"}])).first());
  const session = {...f.input.session, resources:[{type:"memory_store" as const,memoryStoreId:"store",access:"read_write" as const}]};
  const context = {...workStorageContext(),session};
  let mountId = "", failOutput = false, release!:()=>void, entered!:()=>void;
  let gate: Promise<void> | undefined;
  const storage = createNodeSessionStorage({memoryStoreMode:"native",memories:()=>memories,memoryBlobs,outputs:collector,
    ...(mode==="shared"?{sharedOutputs:f.shared}:{}),
    inputs:()=>({prepareStorage:async(input:{runtimeGeneration:string})=>{const mount=await new ManagedMemorySnapshotMaterializer(memories,memoryBlobs).materialize({workspaceId:"ws",sessionId:"sess",memoryStoreId:"store",access:"read_write",runtimeGeneration:input.runtimeGeneration});mountId=mount.mountStoreId;}} as never),
    workOutputs:{synchronize:async input=>{
      const listed=await memories.listMemories({memoryStoreId:"store",projection:"full"});
      expect(listed.type==="page"&&listed.page.items.some(item=>item.kind==="memory"&&item.content==="combined Memory")).toBe(true);
      order.push("memory-synced"); entered?.(); if(gate)await gate;
      if(failOutput)throw Error("output transport failed");
      await collector.synchronizeWork(input);order.push("outputs-published");
    }},isFenceActive:async()=>{throw Error("MA fence used");},warn:()=>{},
  });
  const adapter=fromV1SandboxFactory({name:"test",create:async()=>f.sandbox});
  adapter.lifecycle.keepAlive=async()=>{order.push("provider-renewed");return "alive";};
  let checkpointEntered!: () => void, checkpointRelease!: () => void;
  const checkpointStarted = new Promise<void>(resolve => { checkpointEntered = resolve; });
  const checkpointGate = new Promise<void>(resolve => { checkpointRelease = resolve; });
  adapter.lifecycle.checkpoint=async()=>{order.push("checkpoint");checkpointEntered();await checkpointGate;return {provider:"test",kind:"snapshot",ref:"checkpoint-1"};};
  const authority={...f.input.workAuthority,isCurrent,holderHash:()=>holderHash,token:async()=>"unused"};
  const sandboxes=new NodeSessionSandboxes({adapter:{adapter,image:()=>"test",keepAliveMs:60_000},createV1:async()=>f.sandbox,storage,substitutions:async()=>[],token:async()=>"unused",relay:()=>null,isFenceActive:async()=>false,idlePauseMs:60_000,warn:()=>{}});
  const sandbox=sandboxes.build({...context,workAuthority:authority});
  await sandbox.open();
  memoryBytes.set(mountId+"/note.txt","combined Memory");
  await sandbox.writeFile("/mnt/session/outputs/report.txt","combined output");
  order.length=0;
  const started=new Promise<void>(resolve=>{entered=resolve;});gate=new Promise<void>(resolve=>{release=resolve;});
  const ending=sandbox.endExecution();await started;
  expect(order).toEqual(["memory-synced"]);
  await sandbox.renewActivityTimeout();expect(order).toContain("provider-renewed");
  release();await checkpointStarted;
  const renewalsBeforeCheckpoint = order.filter(step => step === "provider-renewed").length;
  await sandbox.renewActivityTimeout();
  expect(order.filter(step => step === "provider-renewed")).toHaveLength(renewalsBeforeCheckpoint + 1);
  checkpointRelease();await ending;gate=undefined;
  expect(order.indexOf("memory-synced")).toBeLessThan(order.indexOf("outputs-published"));
  expect(order.indexOf("outputs-published")).toBeLessThan(order.indexOf("checkpoint"));
  expect(mode==="shared"?await f.read():await readFile(join(outputsRoot,"ws/sess/report.txt"),"utf8")).toBe("combined output");
  failOutput=true;order.length=0;await sandbox.writeFile("/mnt/session/outputs/report.txt","unpublished");
  await expect(sandbox.endExecution()).rejects.toThrow(/output transport failed/);
  expect(order).not.toContain("checkpoint");expect(order).not.toContain("outputs-published");
  await sandbox.renewActivityTimeout();expect(order).toContain("provider-renewed");
  expect(mode==="shared"?await f.read():await readFile(join(outputsRoot,"ws/sess/report.txt"),"utf8")).toBe("combined output");
  await f.sql.exec("UPDATE managed_environment_work SET claim_generation=2");
  await expect(sandbox.synchronizeWork(authority.attempt)).rejects.toThrow(/Work claim/);
  await sandbox.destroy();
  // The stale facade must not destroy the physical runtime owned by claim 2.
  expect(await f.sandbox.readFile("/mnt/session/outputs/report.txt")).toBe("unpublished");
});

// The complete existing Node storage chain, exercised from the actual Work
// runner + common supervisor callback. This intentionally records the upstream
// ordering defect too: it does NOT certify a pre-terminal safe-point barrier.
it.each(["publish", "claim_lost"] as const)("runs the real Work supervisor through shared output storage: %s", async mode => {
  const { createNodeManagedAcpWorkItemRunner } = await import("../../../packages/harness-runtime-acp/src/node-work-item.js");
  const { createManagedAcpSupervisorHarness } = await import("../../../packages/harness-runtime-acp/src/index.js");
  const { createNodeSessionStorage } = await import("../../../packages/control-plane-node/src/lib/node-session-storage.js");
  const f = await fixture();
  const order: string[] = [];
  const { MemoriesApplicationService } = await import("../../../packages/managed-agents-application/src/memories/application.js");
  const { InMemoryMemoryDocumentStore } = await import("../../../packages/memory-document-store-memory/src/index.js");
  const memories = new MemoriesApplicationService({ workspaceId: "ws", store: new InMemoryMemoryDocumentStore(),
    memoryStores: { find: async () => null }, content: { describe: async () => { throw new Error("no Memory writes"); } },
    actor: { kind: "session", sessionId: "sess" }, clock: { now: () => new Date() }, ids: { nextMemoryId: () => crypto.randomUUID(), nextMemoryVersionId: () => crypto.randomUUID() },
  });
  const composedStorage = createNodeSessionStorage({
    memoryStoreMode: "native", memories: () => memories, memoryBlobs: {} as never, outputs: f.collector,
    workOutputs: { synchronize: input => f.collector.synchronizeWork(input) },
    inputs: () => { throw new Error("already hydrated"); }, isFenceActive: async () => { throw new Error("MA fence used"); }, warn: () => {},
  });
  // Seed the winner before running the turn; lost ownership must preserve it.
  await f.collector.synchronizeWork(f.input);
  if (mode === "claim_lost") f.hook(async () => { await f.sql.exec("UPDATE managed_environment_work SET claim_generation = 2"); });
  const harness = createManagedAcpSupervisorHarness({
    connect: async () => ({
      async *commands() {
        yield { type: "session.start" as const, sessionId: "sess", agentId: "test", runtime: "cloud" as const, cwd: "/workspace" };
        yield { type: "session.prompt" as const, sessionId: "sess", turnId: "turn", text: "write report" };
        yield { type: "control.complete" as const, workId: "work" };
      },
      publish: async event => { order.push(event.type); }, close: async () => { order.push("channel-close"); },
    }),
    acpRuntime: { start: async () => ({
      acpSessionId: "native", isAlive: () => true,
      async *prompt() { await f.sandbox.writeFile("/mnt/session/outputs/report.txt", "turn-produced report"); yield { type: "promptComplete", response: {} }; order.push("prompt-drained"); },
      async dispose() { order.push("model-disposed"); },
    } as never) },
    sessionPreparation: { prepare: async () => ({ agent: { command: "/fixture/acp" } }) },
    sessionState: { beforeStart: async command => ({ command }), onReady: async () => {}, checkpoint: async () => {}, release: async () => {} },
    drainDeadlineMs: 0, abortGraceMs: 0,
  });
  const runner = createNodeManagedAcpWorkItemRunner({
    environment: { ANTHROPIC_BASE_URL: "https://control.test", ANTHROPIC_ENVIRONMENT_ID: "env", ANTHROPIC_SESSION_ID: "sess", ANTHROPIC_WORK_ID: "work", OPENMA_HARNESS_ID: "test",
      ANTHROPIC_WORK_SECRET: Buffer.from(JSON.stringify({ sessions_token: "fixture", api_base_url: "https://control.test" })).toString("base64url") },
    supervisorApp: { resolveHarness: async () => harness, serve: async () => {} },
    fetch: async (raw, init) => { const action = new Request(raw, init).url.split("/").at(-1); order.push(action!); return Response.json(action === "startup-boundary" ? { revision: 1 } : { type: "committed" }); },
    lifecycleClient: { ack: async () => ({}), heartbeat: async () => ({ last_heartbeat: "one", lease_extended: true, state: "running", ttl_seconds: 90 }), stop: async () => { order.push("work-stop"); return {}; } },
    scheduler: { sleep: async (_ms, signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }) },
    checkpoint: async () => { order.push("storage-start"); await composedStorage.synchronizeWork!(f.input); order.push("storage-durable"); },
  });
  if (mode === "publish") {
    await runner.run();
    expect(await f.read()).toBe("turn-produced report");
    expect(order.filter(item => ["prompt-drained", "session.complete", "storage-start", "storage-durable", "model-disposed", "work-stop"].includes(item)))
      .toEqual(["prompt-drained", "session.complete", "storage-start", "storage-durable", "model-disposed", "work-stop"]);
  } else {
    await expect(runner.run()).rejects.toMatchObject({ phase: "finalization" });
    expect(await f.read()).toBe("real Work bytes");
    expect(order).not.toContain("storage-durable");
    expect(order).not.toContain("work-stop");
    expect(order).not.toContain("startup-failed");
    expect((await f.sql.prepare("SELECT claim_generation FROM managed_environment_work").first<{ claim_generation: number }>())?.claim_generation).toBe(2);
  }
});
