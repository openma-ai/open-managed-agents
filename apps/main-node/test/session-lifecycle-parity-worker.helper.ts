import { createNodeAcpHarnessStateIo } from "../../../packages/harness-runtime-acp/src/node.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect } from "vitest";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime.js";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http.js";
import { Disposables } from "../../../packages/control-plane-node/src/lifecycle.js";
import { serve } from "@hono/node-server";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";
import { sandboxTokenSha256 } from "../../../packages/sandbox-gateway/src/index.js";
import { runNodeWorkItemCli } from "../../../packages/harness-runtime-acp/src/node-work-item-cli.js";
import { parityModules, parityPeer, type ParityPeerHooks } from "./session-lifecycle-parity-acp.fixture.js";

// Fixed-main behavioral assertions use the default CLI and real HTTP/SQLite.
// OPENMA_COMMON_CANDIDATE supplies source modules explicitly; absent means installed.
// Physical host/storage is production code over a local subprocess sandbox.
export async function lifecycleFixture(budget?: { type: "limit"; max_list_cost: { amount: string; currency: "USD" } }) {
  const parent = fileURLToPath(new URL("../../../.validation/lifecycle-parity-test-worker/", import.meta.url).href);
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "inputs-"));
  const components = await nodeDefaults(loadNodeConfig({
    NODE_ENV: "test", AUTH_DISABLED: "0", API_KEY: "parity-admin",
    PLATFORM_ROOT_SECRET: "local-lifecycle-parity-test-secret", PUBLIC_BASE_URL: "https://parity.test",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", PROCESS_MODE: "api", MEMORY_QUEUE: "disabled", LOG_LEVEL: "silent",
    DATABASE_PATH: join(root, "db.sqlite"), AUTH_DATABASE_PATH: join(root, "auth.sqlite"),
    SANDBOX_WORKDIR: join(root, "sandbox"), MEMORY_BLOB_DIR: join(root, "memory"),
    FILES_BLOB_DIR: join(root, "files"), SESSION_OUTPUTS_DIR: join(root, "outputs"),
  }));
  const disposables=new Disposables();
  const runtime=await createNodeRuntime(components,disposables,{current:null});
  const app=await mountNodeHttp(runtime,disposables,runtime.workFinalizationHost);
  const cp={components,fetch:(request:Request)=>app.fetch(request),
    start:async()=>{runtime.managedSessionExecutionWorker.start();await runtime.managedEnvironmentWorkWorker.start();},
    stop:async()=>{await runtime.managedEnvironmentWorkWorker.stop();await runtime.managedSessionExecutionWorker.stop();await disposables.dispose();}};
  const nativeFetch=globalThis.fetch.bind(globalThis);
  const sandboxes:Array<Awaited<ReturnType<typeof runtime.sessionSandboxes.build>>> = [];
  const server=serve({fetch:request=>cp.fetch(request),hostname:"127.0.0.1",port:0});
  if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
  const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
  const api = async (path: string, body?: unknown) => {
    const response = await nativeFetch(new Request(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-api-key": "parity-admin", "content-type": "application/json", "Anthropic-Worker-ID": "parity-worker" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBeLessThan(300);
    return data;
  };
  const env = await api("/v1/environments", { name: "parity", config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await api("/v1/agents", { name: "parity", model: "unpriced-test-model", tools: [], _oma: { harness: "acp-sandbox", acp: { agent: { id: "codex-acp", command: process.execPath } } } });
  const session = await api("/v1/sessions", { agent: agent.id, environment_id: env.id, ...(budget ? { budget } : {}) });
  const message = (text: string) => api(
    "/v1/sessions/" + session.id + "/events", { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
  );
  const events = async () => (await api("/v1/sessions/" + session.id + "/events?limit=1000&order=asc")).data as any[];
  const scope = { workspaceId: "default", environmentId: env.id, sessionId: session.id, workId: "" };
  let token = "";
  const claim = async (ack = true) => {
    const work = await api("/v1/environments/" + env.id + "/work/poll?block_ms=1");
    expect(work).not.toBeNull();
    scope.workId = work.id;
    const secret = JSON.parse(Buffer.from(work.secret, "base64url").toString());
    token = secret.sessions_token;
    if (ack) {
    const response = await cp.fetch(new Request("https://parity.test/v1/environments/" + env.id + "/work/" + work.id + "/ack", { method: "POST", headers: { authorization: "Bearer " + token } }));
    expect(response.status, await response.clone().text()).toBe(200);
    }
    return work;
  };
  const publish = async (items: unknown[]) => {
    const response = await cp.fetch(new Request("https://parity.test/v1/oma/sessions/" + session.id + "/runtime-events", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ events: items }),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const prepared=new Map<string,ReturnType<typeof runtime.sessionSandboxes.build>>();
  // Exact handles only: the fixture models the resident management process
  // required by the physical host fence, not an always-alive status callback.
  const management=new Map<string,Awaited<ReturnType<ReturnType<typeof runtime.sessionSandboxes.build>["startManagedProcess"]>>>();
  const stopManagement=async(workId:string,owner?:ReturnType<typeof runtime.sessionSandboxes.build>)=>{
    if(owner!==undefined&&prepared.get(workId)!==owner)return; // old CLI cannot kill successor
    const handle=management.get(workId);
    if(!handle)return;
    await handle.kill("SIGKILL");
    expect(["killed","completed","error","exited"]).toContain(await handle.getStatus());
    if(management.get(workId)===handle){management.delete(workId);prepared.delete(workId);}
  };
  const prepareSandbox=async()=>{
    const cached=prepared.get(scope.workId);
    if(cached){expect(await management.get(scope.workId)!.getStatus()).toBe("running");return cached;}
    // Replacement fixtures have joined the old CLI before preparing the next
    // allocation. Retire only handles this fixture itself started.
    for(const oldWorkId of management.keys())await stopManagement(oldWorkId);
    const stored=await runtime.managedEnvironmentWorkStore.find({workspaceId:"default",environmentId:scope.environmentId,workId:scope.workId});
    if(!stored?.claim)throw Error("No polled Work claim");
    const exact={...scope,generation:stored.claim.generation};
    const session=(await new SqlSessionSource(runtime.sql).find(exact))!;
    const environment=(await new SqlSessionEnvironmentSource(runtime.sql).find(exact))!;
    let holderHash:string|undefined;
    const isCurrent=async()=>{const now=await runtime.managedEnvironmentWorkStore.find(exact);return now?.claim?.generation===exact.generation&&now.claim.workerId===stored.claim!.workerId&&["queued","starting","active","stopping"].includes(now.work.state)&&Date.parse(now.claim.claimedAt)+now.heartbeatTtlSeconds*1000>Date.now();};
    const sandbox=runtime.sessionSandboxes.build({workspaceId:"default",session,environment,workAuthority:{attempt:environmentWorkSandboxTokenRef(exact),isCurrent,holderHash:()=>holderHash,token:physical=>runtime.managedAcpCapabilities.issueWork(exact,session.agent.openma?.harness,physical)}});
    sandboxes.push(sandbox);await sandbox.open();holderHash=(await sandboxTokenSha256(await sandbox.workToken()))!;
    const handle=await sandbox.startManagedProcess({command:"/bin/sleep",args:["120"],env:{}});
    management.set(scope.workId,handle); // register cleanup before any assertion
    expect(await handle.getStatus()).toBe("running");
    await sandbox.writeFile("/mnt/session/outputs/parity-proof.txt","physical Work output");
    prepared.set(scope.workId,sandbox);return sandbox;
  };
  const reclaim=async()=>{
    // Simulated process/lease expiry, not a forged claim/consumption receipt.
    await stopManagement(scope.workId);
    prepared.delete(scope.workId);
    await runtime.sql.prepare("UPDATE managed_environment_work SET claim_at=0 WHERE id=?").bind(scope.workId).run();
    return claim(false);
  };
  return { cp, api, session, scope, message, events, claim, publish,base,nativeFetch,root,prepareSandbox,reclaim,stopManagement,
    token: () => token,
    dispose: async () => { if("closeAllConnections" in server)server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));for(const workId of management.keys())await stopManagement(workId);await Promise.all(sandboxes.map(s=>s.destroy()));await cp.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

export function lifecycleWorker(f:Awaited<ReturnType<typeof lifecycleFixture>>,hooks:ParityPeerHooks,onHeartbeat?:(response:Response)=>Promise<void>,executionToken?:string) {
 const workId=f.scope.workId;
 const controller=new AbortController(),errors:unknown[]=[],requests:string[]=[],responses:Array<{action:string;status:number;body:unknown}>=[];
 let settled=false;
 let sandbox:Awaited<ReturnType<typeof f.prepareSandbox>>|undefined;
 const result=(async()=>{
  sandbox=await f.prepareSandbox();
  const modules=await parityModules();
  const ioRoot=join(f.root,"native-"+crypto.randomUUID());await mkdir(ioRoot,{recursive:true});
  const io=createNodeAcpHarnessStateIo({workspacePath:ioRoot});
  const map=(p:string)=>p.replaceAll("/workspace",ioRoot).replaceAll("/oma",join(ioRoot,"platform"));
  const stateIo={readFile:(p:string)=>io.readFile(map(p)),writeFile:(p:string,v:string)=>io.writeFile(map(p),v),writeFileBytes:(p:string,v:Uint8Array)=>io.writeFileBytes(map(p),v),exec:async(command:string)=>{const r=await promisify(execFile)("/bin/sh",["-c",map(command)],{cwd:ioRoot,env:{...process.env,HOME:ioRoot},maxBuffer:16*1024*1024});return r.stdout;}};
  await runNodeWorkItemCli({environment:{ANTHROPIC_ENVIRONMENT_ID:f.scope.environmentId,ANTHROPIC_SESSION_ID:f.scope.sessionId,ANTHROPIC_WORK_ID:f.scope.workId,OPENMA_HARNESS_ID:"acp",OPENMA_ACP_AGENT_ID:executionToken?"claude-acp":"codex-acp",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:f.token(),api_base_url:f.base})).toString("base64url")},signal:controller.signal,heartbeatIntervalMs:50,
   runtime:{modules,spawner:parityPeer(hooks,executionToken?"claude":"codex"),stateIo},
   ...(executionToken?{resolveExecutionChannels:async()=>({type:"ready" as const,channels:{mcpProxy:{gatewayBaseUrl:f.base,sessionsToken:executionToken},hostedInference:{gatewayBaseUrl:f.base,sessionsToken:executionToken,model:{providerId:"anthropic",baseUrl:"https://provider.test",wireModel:"upstream"}}}})}:{}),
   fetch:async(raw,init)=>{const request=new Request(raw,init);const action=new URL(request.url).pathname.split("/").at(-1)!;requests.push(action);const response=await f.nativeFetch(request);if(action!=="heartbeat"&&action!=="inputs-read")responses.push({action,status:response.status,body:await response.clone().json().catch(()=>null)});if(action==="heartbeat")await onHeartbeat?.(response.clone());return response;},onError:error=>{errors.push(error);},
  });return {ok:true};
 })().catch(error=>{return {error};}).finally(()=>{settled=true;});
 const stop=async()=>{controller.abort(Error("test cleanup"));await result;if(sandbox)await f.stopManagement(workId,sandbox);};
 return {result,errors,requests,responses,stop,polls:()=>requests.filter(p=>p==="inputs-read"||p==="work-bootstrap"||p==="work-recovery").length,
  async waitFor<T>(condition:()=>Promise<T>|T,expected:T,timeout=2500){
   await expect.poll(async()=>{const value=await condition();if(JSON.stringify(value)!==JSON.stringify(expected)&&settled){const outcome=await result;if("error" in outcome)throw outcome.error;}return value;},{timeout}).toEqual(expected);
  },
  async published(successfulTurn=true){
   await expect.poll(()=>responses.some(r=>r.action==="work-publish"&&r.status===200),{timeout:3000}).toBe(true);
   if(!successfulTurn)return; // fixed main skips successful workspace checkpoint on run failure
   const checkpoint=await f.cp.components.database.sql.prepare("SELECT candidate_json FROM managed_session_workspace_checkpoints WHERE workspace_id='default' AND session_id=?").bind(f.session.id).first();
   expect(checkpoint).not.toBeNull();
   expect(await readFile(join(f.root,"outputs","default",f.session.id,"parity-proof.txt"),"utf8")).toBe("physical Work output");
  },
  /** Relaunch over an already-terminal turn (harness-runtime-acp 7624a68d):
   * the worker publishes that canonical receipt exactly once under its own
   * claim, then stays resident polling for new input instead of exiting into
   * another reclaim. Bootstrap keeps re-offering the same receipt; it must
   * never be republished and must never end the runner. */
  async residentAfterPublish(){
   await this.waitFor(()=>responses.filter(r=>r.action==="work-publish").map(r=>r.status),[200],5000);
   const afterPublish=requests.length;
   await expect.poll(()=>{if(settled)throw Error("Runner exited after publishing the settled receipt");return requests.slice(afterPublish).filter(a=>a==="work-bootstrap").length;},{timeout:5000}).toBeGreaterThanOrEqual(2);
   expect(responses.filter(r=>r.action==="work-publish").map(r=>r.status)).toEqual([200]);
   expect(settled).toBe(false);
  },
  async reached(gate:Promise<unknown>){await Promise.race([gate,result.then(outcome=>{if("error" in outcome)throw outcome.error;throw Error("Runner exited before expected milestone");})]);},
 };
}
