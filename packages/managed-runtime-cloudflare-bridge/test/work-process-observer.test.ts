import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { CloudflareBridgeRuntime } from "../src/cloudflare-bridge";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const scope = { workspaceId: "tenant", environmentId: "env", sessionId: "session", workId: "work", generation: 2, holder: "owner" };
const observation = { status: "running", runtimeId: "physical", process: { id: "uuid", epoch: "epoch", pid: 41, startTicks: "123" }, work: { ...scope, attemptId: "environment-work-claim:2" } };
async function fixture(body: unknown = observation, status = 200, headers: Record<string,string> = {}) {
 const calls: string[] = [];
 const server = createServer((req, res) => { calls.push(req.method + " " + req.url); expect(req.headers.authorization).toBe("Bearer operator-key"); res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof body === "string" ? body : JSON.stringify(body)); });
 servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("listen failed");
 return { calls, runtime: new CloudflareBridgeRuntime({ baseUrl:`http://127.0.0.1:${address.port}`,apiKey:"operator-key",runtimeId:"physical",checkpointStore:new InMemoryBlobStore() }) };
}
it("uses one GET to the exact scoped process observer, never /running, attach, or exec", async () => {
 const f=await fixture();expect(await f.runtime.observeWorkProcess(scope)).toEqual(observation);
 expect(f.calls).toEqual(["GET /v1/sandbox/physical/work-process?workspaceId=tenant&environmentId=env&sessionId=session&workId=work&generation=2&holder=owner"]);
});
it.each(["runtime","work","holder","attempt","pid","ticks","hash","container-only","unknown","oversized","bad-json"])("does not certify %s", async kind=>{
 const body={...structuredClone(observation),...(kind==="hash"?{holderHash:"secret"}:{})};
 if(kind==="runtime")body.runtimeId="foreign";if(kind==="work")body.work.workId="foreign";if(kind==="holder")body.work.holder="foreign";if(kind==="attempt")body.work.attemptId="environment-work-claim:1";
 if(kind==="pid")body.process.pid=0;if(kind==="ticks")body.process.startTicks="";
 const f=await fixture(kind==="container-only"?{running:true}:kind==="unknown"?{status:"unknown"}:kind==="oversized"?"x".repeat(17000):kind==="bad-json"?"{":body);
 await expect(f.runtime.observeWorkProcess(scope)).rejects.toThrow();expect(f.calls).toHaveLength(1);
});
it.each([401,403,404,409,410,503,302])("HTTP %s stays unknown and never follows redirects", async status=>{
 const f=await fixture({error:"private-upstream-error"},status,{location:"/should-not-follow"});
 await expect(f.runtime.observeWorkProcess(scope)).rejects.toThrow(/observation/i);expect(f.calls).toHaveLength(1);
});

it("rejects invalid scope before making any request", async () => {
 const f=await fixture();
 await expect(f.runtime.observeWorkProcess({...scope,generation:0})).rejects.toThrow();
 expect(f.calls).toEqual([]);
});
it("never returns unrecognized caller scope fields", async () => {
 const f=await fixture();
 expect(await f.runtime.observeWorkProcess({...scope,secret:"private"} as typeof scope)).toEqual(observation);
});
it("sanitizes transport errors", async () => {
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"operator-key",runtimeId:"physical",checkpointStore:new InMemoryBlobStore(),fetch:async()=>{throw Error("operator-key private-token");}});
 await expect(runtime.observeWorkProcess(scope)).rejects.toThrow("Work process observation unavailable or mismatched");
});

it.each(["request", "body", "cancel"])("bounds a hanging observation %s even when transport ignores abort", async kind => {
 vi.useFakeTimers();
 const runtime = new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"operator-key",runtimeId:"physical",checkpointStore:new InMemoryBlobStore(),fetch:async()=>{
  if(kind==="request")return new Promise<Response>(()=>{});
  return new Response(new ReadableStream({pull:()=>new Promise<void>(()=>{}),cancel:()=>new Promise<void>(()=>{})}),{status:kind==="cancel"?503:200,headers:{"content-type":"application/json"}});
 }});
 let result: unknown;
 const pending=runtime.observeWorkProcess(scope).catch(error=>{result=error;});
 try {await vi.advanceTimersByTimeAsync(5_100);expect(result).toBeInstanceOf(Error);await pending;}
 finally {vi.useRealTimers();}
});

it("binds to the requested scope even if the caller mutates it during IO", async () => {
 const requested={...scope};
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"operator-key",runtimeId:"physical",checkpointStore:new InMemoryBlobStore(),fetch:async()=>{
  requested.holder="successor";
  return Response.json({...observation,work:{...observation.work,holder:"successor"}});
 }});
 await expect(runtime.observeWorkProcess(requested)).rejects.toThrow(/mismatched/);
});
