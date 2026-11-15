import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { SandboxGoneError, startSandboxHeartbeat } from "@open-managed-agents/sandbox";
// Real Node HTTP/SQLite, runtime owner and local provider. Inject one failure
// at the provider boundary; canonical tool/result and turn handling are real.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PiHarness, registerHarness, type HarnessContext } from "@open-managed-agents/agent-harness";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { createNodeControlPlane } from "../src/control-plane";


it.each([["gone",false],["transport",false],["gone",true],["transport",true],["lease",false]] as const)("provider %s failure returns one result (mixed custom: %s)", async (failure,mixed) => {
  let providerFailures = 0;
  let reading = false, leaseLost = false, replacementFailed = false;
  let stopLeaseProbe: (() => Promise<void>) | undefined;
  const dir = mkdtempSync(join(tmpdir(), "oma-tool-error-"));
  const rpc = createServer(async (req,res) => {
    if(req.method!=="POST"){res.writeHead(405).end();return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const m=JSON.parse(Buffer.concat(chunks).toString());
    if(m.id===undefined){res.writeHead(202).end();return;}
    let result:any;
    if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"lease-effect",version:"1"}};
    else if(m.method==="tools/list")result={tools:[{name:"effect",description:"independent successful action",inputSchema:{type:"object",properties:{}}}]};
    else if(m.method==="tools/call"){appendFileSync(join(dir,"mcp-effect"),"x");result={content:[{type:"text",text:"success after lease loss"}]};}
    else {res.writeHead(400).end();return;}
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
  });
  if(failure==="lease") await new Promise<void>(r=>rpc.listen(0,"127.0.0.1",r));
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  let seen = ""; let afterAction = "";
  faux.setResponses([
    fauxAssistantMessage([...(mixed ? [fauxToolCall("approve_ticket",{ticket:"c1"},{id:"c1"})] : []), fauxToolCall("read", { file_path: join(dir, "absent-file.txt") }, { id: "failed-read" }), ...(mixed ? [fauxToolCall("approve_ticket",{ticket:"c2"},{id:"c2"})] : [])], { stopReason: "toolUse" }),
    context => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage([fauxToolCall(failure==="lease"?"mcp__docs__effect":"write", failure==="lease"?{}:{
        file_path: "/continued-action.txt", content: "successful action after error",
      }, { id: "successful-after-error" })], { stopReason: "toolUse" });
    },
    context => { afterAction = JSON.stringify(context.messages); return fauxAssistantMessage("continued after tool error"); },
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const harnessId = "tool-error-" + Math.random().toString(36).slice(2);
  registerHarness(harnessId, () => ({ async run(ctx: HarnessContext) {
    await new PiHarness().run({ ...ctx, pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" } });
  } }));
  const config = loadNodeConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess", MEMORY_QUEUE: "disabled", DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"), FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs") });
  const components = await nodeDefaults(config);
  const provider = components.sessionSandboxProvider!.provider;
  const wrap = (target: any) => new Proxy(target, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if(failure==="lease" && key==="runtimeCapabilities")return ()=>({...target.runtimeCapabilities(),lease:true});
    if(failure==="lease" && key==="status")return async()=>leaseLost?"stopped":"running";
    if(failure==="lease" && key==="renewLease")return async()=>{if(reading){leaseLost=true;throw new SandboxGoneError("provider lease lost while tool read is pending");}};
    if (key === "readFileBytes" || key === "readFile") return async (...args: any[]) => {
      if (String(args[0]).includes("absent-file.txt") && providerFailures++ === 0) {
        console.log(JSON.stringify({op:"provider.fault",failure,method:key,runtime_id:target.runtimeHandle().runtimeId}));
        if(failure==="lease"){
          reading=true;
          await expect.poll(()=>leaseLost,{timeout:3000}).toBe(true);
          throw new SandboxGoneError("read failed after provider lease loss");
        }
        if (failure === "gone") throw new SandboxGoneError("injected provider reclamation before operation dispatch");
        throw new Error("injected provider transport unavailable before dispatch");
      }
      return value.apply(target,args);
    };
    return value.bind(target);
  }});
  components.sessionSandboxProvider = {...components.sessionSandboxProvider!, provider: {
    ...provider,
    create: async (...args: Parameters<typeof provider.create>) => {
      if(failure==="lease" && leaseLost){replacementFailed=true;throw new Error("isolated provider replacement refused");}
      const runtime = wrap(await provider.create(...args));
      if(failure==="lease") stopLeaseProbe=startSandboxHeartbeat(()=>runtime,{ttlMs:60_000,intervalMs:10,
        onRenewFailed:()=>{console.log(JSON.stringify({op:"provider.lease.loss",while_tool_pending:reading}));void stopLeaseProbe?.();}});
      return runtime;
    },
    resume: async (...args: Parameters<typeof provider.resume>) => {
      if(failure==="lease" && leaseLost){replacementFailed=true;throw new Error("isolated provider replacement refused");}
      const runtime=wrap(await provider.resume(...args));
      if(failure==="lease" && !stopLeaseProbe){
        console.log(JSON.stringify({op:"provider.lease.probe.start",path:"resume",capabilities:runtime.runtimeCapabilities()}));
        stopLeaseProbe=startSandboxHeartbeat(()=>runtime,{ttlMs:60_000,intervalMs:10,onRenewFailed:()=>{console.log(JSON.stringify({op:"provider.lease.loss",while_tool_pending:reading}));void stopLeaseProbe?.();}});
      }
      return runtime;
    },
  }};
  const cp = await createNodeControlPlane(components); await cp.start();
  const db = new Database(join(dir, "oma.db"), { readonly: true });
  const server = serve({ fetch: r => cp.fetch(r), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const ok = async (path: string, body?: unknown) => { const r = await call(path, body); expect(r.status, JSON.stringify(r.body)).toBeLessThan(300); return r.body; };
  const live = () => (db.prepare("SELECT COUNT(*) c FROM managed_session_executions WHERE state IN ('queued','running')").get() as { c: number }).c;
  try {
    await ok("/v1/oma/model_cards", { provider: "ant", model_id: "tool-error-local-model", api_key: "test", base_url: "http://unused.invalid" });
    const agent = await ok("/v1/agents", { name: "dup", model: "tool-error-local-model", system: "t", _oma: { harness: harnessId },
      ...(failure==="lease"?{mcp_servers:[{type:"url",name:"docs",url:`http://127.0.0.1:${(rpc.address() as any).port}/mcp`}]}:{}),
      tools: [...(failure==="lease"?[{type:"mcp_toolset",mcp_server_name:"docs"}]:[]),{ type: "agent_toolset_20260401" }, { type: "custom", name: "approve_ticket", description: "a", input_schema: { type: "object", properties: { ticket: { type: "string" } }, required: ["ticket"] } }] });
    const env = await ok("/v1/environments", { name: "dup", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const session = await ok("/v1/sessions", { agent: { type: "agent", id: agent.id, version: agent.version }, environment_id: env.id });
    const path = `/v1/sessions/${session.id}/events`;
    const history = async () => (await ok(path + "?limit=1000&order=asc")).data as any[];
    await ok(path, { events: [{ type: "user.message", content: [{ type: "text", text: "Read a missing file and continue" }] }] });
    if (mixed) {
      await expect.poll(async () => live() === 0 && (await history()).some(e => e.type === "session.status_idle" && e.stop_reason.type === "requires_action"), {timeout:15_000}).toBe(true);
      const parked = await history();
      expect(parked.findIndex(e=>e.type === "agent.tool_result" && e.tool_use_id === "failed-read")).toBeLessThan(parked.findIndex(e=>e.type === "session.status_idle"));
      const answer = (id:string) => ok(path,{events:[{type:"user.custom_tool_result",custom_tool_use_id:id,content:[{type:"text",text:"approved"}]}]});
      await answer("c1"); await expect.poll(live).toBe(0); expect(faux.state.callCount).toBe(1);
      await answer("c1"); await expect.poll(live).toBe(0); expect(faux.state.callCount).toBe(1);
      await answer("c2");
    }
    await expect.poll(async () => live() === 0 && (await history()).some(e => e.type === "session.status_idle" && e.stop_reason.type === "end_turn"), { timeout: 15_000 }).toBe(true);
    const events = await history();
    console.log(JSON.stringify({op:"provider.failure.timeline",failure,session_id:session.id,model_calls:faux.state.callCount,providerFailures,events:events.filter(e=>["agent.tool_use","agent.tool_result","session.error","session.status_idle"].includes(e.type)),execution:db.prepare("SELECT state,attempt_count,failure FROM managed_session_executions WHERE session_id=?").all(session.id)}));
    const results = events.filter(e => (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") && (e.tool_use_id ?? e.mcp_tool_use_id) === "failed-read");
    expect(results).toHaveLength(1); expect(results[0].is_error).toBe(true);
    expect(JSON.parse(seen).filter((message: any) => message.role === "toolResult" && message.toolCallId === "failed-read")).toEqual([expect.objectContaining({isError:true})]);
    expect(faux.state.callCount).toBe(3); expect(providerFailures).toBe(1);
    const success = events.filter(e => (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") && (e.tool_use_id ?? e.mcp_tool_use_id) === "successful-after-error");
    expect(success).toHaveLength(1); expect(success[0].is_error).not.toBe(true);
    if(failure==="lease") { expect(readFileSync(join(dir,"mcp-effect"),"utf8")).toBe("x");expect(leaseLost).toBe(true); expect(replacementFailed).toBe(true); }
    else expect(readFileSync(join(dir, "sandboxes", session.id, "continued-action.txt"), "utf8")).toBe("successful action after error");
    expect(afterAction).toContain("successful-after-error");
    expect(events.indexOf(results[0])).toBeLessThan(events.indexOf(success[0]));
    expect(events.slice(0, events.indexOf(success[0])).some(e => (e.type === "session.status_idle" && e.stop_reason.type !== "requires_action") || e.type === "session.status_terminated")).toBe(false);
    if (failure === "gone") expect(events.filter(e => e.type === "session.warning" && e.source === "sandbox.persistence")).toHaveLength(1);
    expect(events.filter(e => e.type === "session.error")).toEqual([]);
    const idleReasons = events.filter(e => e.type === "session.status_idle").map(e => e.stop_reason.type);
    expect(idleReasons.filter(reason => reason !== "requires_action")).toEqual(["end_turn"]);
    if (mixed) expect(idleReasons[0]).toBe("requires_action");
    else expect(idleReasons).toEqual(["end_turn"]);
    expect(events.some(e => e.type === "agent.message" && JSON.stringify(e).includes("continued after tool error"))).toBe(true);
    for (const execution of db.prepare("SELECT state,attempt_count FROM managed_session_executions WHERE session_id=?").all(session.id)) expect(execution).toMatchObject({state:"completed",attempt_count:1});
    expect(events.findIndex(e => e === results[0])).toBeLessThan(events.findIndex(e => e.type === "session.status_idle"));
  } finally {
    await stopLeaseProbe?.();
    if(failure==="lease")await new Promise<void>(r=>rpc.close(()=>r()));
    await new Promise<void>(r => server.close(() => r())); db.close(); await cp.stop("test"); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
