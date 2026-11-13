// Provider rejection during preparation is distinct from a tool job failure:
// no call ID exists and no model may run. Real Work/Session/D1, provider fault.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it.each(["outputs-mount", "memory-config"])("fails preparation explicitly for %s without model/tool execution", async mode => {
  const request = async (path: string, body?: unknown) => {
    const response = await exports.default.fetch(new Request(`http://localhost/v1${path}`, {
      method: body === undefined ? "GET" : "POST", headers: {"x-api-key":"test-key","content-type":"application/json"},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    }));
    const value = await response.json() as any;
    expect(response.ok,JSON.stringify(value)).toBe(true); return value;
  };
  const agent = await request("/agents",{name:mode,model:"unused-preflight-model",tools:[]});
  const environment = await request("/environments",{name:mode,config:{type:"cloud"}});
  const store = mode === "memory-config" ? await request("/memory_stores",{name:"preflight-notes"}) : null;
  const session = await request("/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id,
    ...(store ? {resources:[{type:"memory_store",memory_store_id:store.id,access:"read_write"}]} : {})});
  const stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default",session.id])));
  let rejected=0;
  const saved=await runInDurableObject(stub,async(instance:any)=>{
    if(mode === "memory-config") {const value=instance.env.MEMORY_BUCKET_NAME; delete instance.env.MEMORY_BUCKET_NAME;return value;}
    instance.ensureSandboxCreated();
    const state=instance.portsSandbox.state;
    // Fail the physical provider mount/provision operation, not warmUpSandbox
    // or the Session catch, so the real lifecycle rollback path is exercised.
    const runtime=state.options.executor();
    const provision=runtime.provisionSandbox.bind(runtime);
    runtime.provisionSandbox=async (...args:any[])=>{
      if(args[0]?.mounts?.some((mount:any)=>mount.mountPath==="/mnt/session/outputs")) {rejected++;throw new Error("fixture provider mount denied");}
      return provision(...args);
    };
    return undefined;
  });
  try {
    await request(`/sessions/${session.id}/events`,{events:[{type:"user.message",content:[{type:"text",text:"preflight"}]}]});
    const history=async()=>(await request(`/sessions/${session.id}/events`)).data as any[];
    await expect.poll(async()=>(await env.MAIN_DB.prepare("SELECT state FROM managed_session_executions WHERE session_id=?").bind(session.id).first<{state:string}>())?.state,{timeout:15000}).toBe("failed");
    const events=await history();
    expect(JSON.stringify(events)).toContain(mode === "memory-config" ? "MEMORY_BUCKET_NAME" : "fixture provider mount denied");
    expect(events.filter(e=>e.type.startsWith("agent.")||e.type==="span.model_request_start")).toEqual([]);
    expect(events.filter(e=>e.type==="session.status_idle").map(e=>e.stop_reason.type)).toEqual(["retries_exhausted"]);
    if(mode === "outputs-mount") expect(rejected).toBeGreaterThan(0);
  } finally {
    await runInDurableObject(stub,async(instance:any,state)=>{
      if(mode === "memory-config") instance.env.MEMORY_BUCKET_NAME=saved;
      await instance._recoveryPromise;await instance._recoveryRun;await instance._finalizePromise;
      await Promise.all(instance._maintenanceRuns.values());await state.storage.deleteAlarm();
    });
  }
},30000);
