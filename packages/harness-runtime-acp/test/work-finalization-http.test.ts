import { expect, it } from "vitest";
import { buildWorkFinalizationRoutes } from "../../http-routes/src/work-finalization.js";
import { WorkFinalizationApplication } from "../../managed-agents-application/src/work-finalization/application.js";
import { createWorkFinalizationHttpClient } from "../src/work-finalization-http.js";

const terminal = { eventId: "terminal", turnId: "turn", workId: "work", generation: 1, revision: 4, stopReason: { type: "end_turn" as const } };
function fixture() {
  let consumed = false, committed = false;
  const effects: string[] = [];
  const app = new WorkFinalizationApplication({
    persistence: {
      inspect: async () => ({ type: "current", consumed, revision: committed ? 4 : 3, terminal: committed ? terminal : null }),
      commit: async () => { committed = true; effects.push("commit"); return { type: "current", consumed, revision: 4, terminal }; },
    },
    host: { prepare: async () => { effects.push("prepare"); return { type: "prepared" }; }, publish: async () => { effects.push("publish"); return { type: "published" }; } },
  });
  const router = buildWorkFinalizationRoutes({
    authenticate: async token => token === "scoped" ? { workspaceId: "ws", environmentId: "env", sessionId: "s", workId: "work", generation: 1, holder: "worker" } : null,
    applicationFor: async () => app,
  });
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (raw, init) => { const req = new Request(raw, init); requests.push(req); return router.fetch(new Request(req.url.replace("/v1/oma/sessions", ""), req)); };
  return { effects, requests, fetch, consume: () => { consumed = true; } };
}
it("joins the real HTTP route/application prepare, terminal commit and publication", async () => {
  const f = fixture();
  const client = createWorkFinalizationHttpClient({ apiBaseUrl: "https://host", sessionId: "s", sessionsToken: "scoped", fetch: f.fetch });
  const signal = new AbortController().signal;
  expect(await client.recover("turn", signal)).toEqual({ type: "run", turnId: "turn", revision: 3 });
  f.consume();
  expect(await client.recover("turn", signal)).toEqual({ type: "gap", reason: "consumed_turn_without_terminal", revision: 3 });
  expect(await client.checkpoint({ turnId: "turn", revision: 3 }, signal)).toEqual({ type: "prepared", turnId: "turn", revision: 3 });
  expect(await client.finalize({ turnId: "turn", revision: 3, stopReason: { type: "end_turn" } }, signal)).toEqual({ type: "committed", revision: 4, terminal });
  expect(await client.publish({ turnId: "turn", revision: 4, terminalEventId: "terminal" }, signal)).toEqual({ type: "published", revision: 4, terminal });
  expect(f.effects).toEqual(["prepare", "prepare", "commit", "publish"]);
  expect(f.requests.every(req => req.headers.get("authorization") === "Bearer scoped")).toBe(true);
});
it.each(["turn", "receipt", "revision", "type"])("rejects malformed %s identity rather than accepting a generic success", async mode => {
  const value = mode === "turn" ? { type: "run", turnId: "other", revision: 3 }
    : mode === "receipt" ? { type: "committed", revision: 4, terminal: { ...terminal, turnId: "other" } }
    : mode === "revision" ? { type: "committed", revision: 2, terminal }
    : { type: "ok" };
  const client = createWorkFinalizationHttpClient({ apiBaseUrl: "https://host", sessionId: "s", sessionsToken: "scoped", fetch: async () => Response.json(value) });
  await expect(client.recover("turn", new AbortController().signal)).rejects.toThrow(/Invalid/);
});
it("does not retry an ambiguous terminal mutation", async () => {
  let mutations = 0;
  const client = createWorkFinalizationHttpClient({ apiBaseUrl: "https://host", sessionId: "s", sessionsToken: "scoped", fetch: async () => { mutations++; throw Error("response lost"); } });
  await expect(client.finalize({ turnId: "turn", revision: 3, stopReason: { type: "end_turn" } }, new AbortController().signal)).rejects.toMatchObject({ outcome: "unknown" });
  expect(mutations).toBe(1);
});

it("re-reads a consumed turn and retries one checkpoint revision race", async () => {
  const actions: string[] = [];
  let checkpointAttempts = 0;
  const client = createWorkFinalizationHttpClient({
    apiBaseUrl: "https://host", sessionId: "s", sessionsToken: "scoped",
    fetch: async (raw, init) => {
      const action = new URL(new Request(raw, init).url).pathname.split("/").at(-1)!;
      actions.push(action);
      if (action === "work-checkpoint" && checkpointAttempts++ === 0) return Response.json({ type: "rejected", reason: "turn_revision" }, { status: 409 });
      if (action === "work-recovery") return Response.json({ type: "gap", reason: "consumed_turn_without_terminal", revision: 4 }, { status: 409 });
      if (action === "work-checkpoint") return Response.json({ type: "prepared", turnId: "turn", revision: 4 });
      throw new Error(`unexpected ${action} ${String(init?.body)}`);
    },
  });
  await expect(client.checkpoint({ turnId: "turn", revision: 3 }, new AbortController().signal))
    .resolves.toEqual({ type: "prepared", turnId: "turn", revision: 4 });
  expect(actions).toEqual(["work-checkpoint", "work-recovery", "work-checkpoint"]);
});

it("keeps non-JSON gateway responses diagnosable without replaying the mutation", async () => {
  let mutations = 0;
  const client = createWorkFinalizationHttpClient({
    apiBaseUrl: "https://host", sessionId: "s", sessionsToken: "scoped",
    fetch: async () => {
      mutations += 1;
      return new Response("<!doctype html><title>Bad Gateway</title>", {
        status: 502, headers: { "content-type": "text/html" },
      });
    },
  });
  await expect(client.finalize({ turnId: "turn", revision: 3, stopReason: { type: "end_turn" } }, new AbortController().signal))
    .rejects.toMatchObject({ outcome: "unknown", diagnostics: { action: "work-finalize", status: 502, bodyKind: "html" } });
  expect(mutations).toBe(1);
});

it("actual CLI and SDK use loopback HTTP to recover and publish without a model", async () => {
  const { createServer } = await import("node:http");
  const { runNodeWorkItemCli } = await import("../src/node-work-item-cli.js");
  const calls:string[]=[];
  const app = new WorkFinalizationApplication({ persistence:{
    inspect:async()=>({type:"current",consumed:true,revision:4,terminal}),
    commit:async()=>{throw Error("cleanup must not recommit");},
  },host:{prepare:async()=>{throw Error("cleanup must not checkpoint");},publish:async scope=>{expect(scope.terminal).toEqual(terminal);calls.push("artifacts");return {type:"published"};}} });
  const routes=buildWorkFinalizationRoutes({authenticate:async token=>token==="scoped"?{workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"work",generation:2,holder:"worker"}:null,applicationFor:async()=>app});
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url!,"http://localhost");const action=url.pathname.split('/').at(-1)!;calls.push(action);
      expect(req.headers.authorization).toBe("Bearer scoped");
      let response:Response;
      if(action==="ack")response=Response.json({});
      else if(action==="heartbeat")response=Response.json({last_heartbeat:"beat",lease_extended:true,state:"running",ttl_seconds:90});
      else {
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        response=await routes.fetch(new Request("http://localhost"+url.pathname.replace('/v1/oma/sessions',''),{method:req.method,headers:{authorization:req.headers.authorization!,"content-type":"application/json"},body:Buffer.concat(chunks)}));
      }
      res.writeHead(response.status,{"content-type":"application/json"});res.end(await response.text());
    } catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const port=(server.address() as {port:number}).port;
    await runNodeWorkItemCli({environment:{ANTHROPIC_ENVIRONMENT_ID:"env",ANTHROPIC_SESSION_ID:"s",ANTHROPIC_WORK_ID:"work",OPENMA_HARNESS_ID:"test",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:"scoped",api_base_url:`http://127.0.0.1:${port}`})).toString("base64url")},
      recovery:{resolveTurn:async()=>"turn"},supervisorFactory:()=>{throw Error("must not resolve model");},
    });
    expect(calls).toEqual(["ack","heartbeat","work-recovery","work-publish","artifacts"]);
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
