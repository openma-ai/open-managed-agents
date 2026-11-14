import { describe, expect, it, vi } from "vitest";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";
import { CloudflareBridgeRuntime } from "../src/cloudflare-bridge";

function fixture(terminal = true) {
  const calls: Request[] = [];
  const bodies: unknown[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/process") && request.method === "POST") { bodies.push(await request.json()); return Response.json({ id: "process-1" }); }
    if (path.endsWith("/events")) return new Response("event: stdout\ndata: AP8=\n\nevent: stderr\ndata: ZXJy\n\n" + (terminal ? 'event: exit\ndata: {"exit_code":7}\n\n' : ''), { headers: { "content-type": "text/event-stream" } });
    if (path.endsWith("/stdin")) { bodies.push(request.method === "POST" ? [...new Uint8Array(await request.arrayBuffer())] : "EOF"); return new Response(null, {status:204}); }
    if (path.endsWith("/signal")) { bodies.push(await request.json()); return Response.json({ exit_code: 137 }); }
    if (path.endsWith("/session")) return Response.json({ id: "session" });
    if (path.includes("/session/")) return new Response(null, {status:204});
    return new Response("unexpected route", {status:404});
  };
  const runtime = new CloudflareBridgeRuntime({ baseUrl: "https://bridge.test", apiKey: "isolated-key", runtimeId: "sandbox", checkpointStore: new InMemoryBlobStore(), fetch });
  return {runtime, calls, bodies};
}
const bytes = async (stream: ReadableStream<Uint8Array>) => [...new Uint8Array(await new Response(stream).arrayBuffer())];
describe("native bridge non-PTY process contract", () => {
  it("uses process ID SSE, raw binary stdin, EOF and real exit independently", async () => {
    const f = fixture();
    const process = await f.runtime.spawnDuplexProcess({ command: "cat", args: ["-"], cwd: "/workspace" });
    const writer = process.stdin.getWriter();
    await writer.write(new Uint8Array([0,255])); await writer.close();
    const [stdout, stderr, exit] = await Promise.all([bytes(process.stdout), bytes(process.stderr), process.exited]);
    expect({stdout,stderr,exit}).toEqual({stdout:[0,255],stderr:[101,114,114],exit:{code:7,signal:null}});
    expect(f.bodies).toContainEqual({argv:["cat","-"],cwd:"/workspace"});
    expect(f.bodies).toContainEqual([0,255]); expect(f.bodies).toContain("EOF");
    expect(f.calls.every(request => request.headers.get("authorization") === "Bearer isolated-key")).toBe(true);
    expect(f.calls.some(request => new URL(request.url).pathname.endsWith("/exec"))).toBe(false);
  });
  it("signals the remote process and never treats a disconnected stream as confirmed exit", async () => {
    const f = fixture(false);
    const process = await f.runtime.spawnDuplexProcess({command:"worker"});
    const settled = Promise.allSettled([bytes(process.stdout),bytes(process.stderr),process.exited]);
    await process.kill("SIGKILL");
    expect(f.bodies).toContainEqual({signal:"SIGKILL"});
    expect((await settled)[2].status).toBe("rejected");
  });
});

it.each(["OUTPUT_INCOMPLETE", "PROCESS_LOST"])("keeps output failure separate from a following real exit: %s", async code => {
  const runtime = new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:new InMemoryBlobStore(),fetch:async input => {
    if(String(input).endsWith("/process")) return Response.json({id:"output-loss"});
    if(String(input).endsWith("/events")) return new Response('event: error\ndata: '+JSON.stringify({code,error:"output unavailable"})+'\n\nevent: exit\ndata: {"exit_code":143}\n\n',{headers:{"content-type":"text/event-stream"}});
    return new Response(null,{status:204});
  }});
  const process = await runtime.spawnDuplexProcess({command:"worker"});
  const settled = await Promise.allSettled([bytes(process.stdout),bytes(process.stderr),process.exited]);
  if(code === "OUTPUT_INCOMPLETE") {
    expect(settled[2]).toEqual({status:"fulfilled",value:{code:143,signal:null}});
    expect(settled[0]).toMatchObject({status:"rejected",reason:{code:"OUTPUT_INCOMPLETE"}});
  } else expect(settled[2].status).toBe("rejected");
});

it.each(["eof", "hang", "invalid"])("does not invent exit after OUTPUT_INCOMPLETE and %s", async ending => {
  vi.useFakeTimers();
  let cancelled = false;
  const runtime = new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:new InMemoryBlobStore(),fetch:async input => {
    if(String(input).endsWith("/process")) return Response.json({id:"no-exit"});
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('event: error\ndata: {"code":"OUTPUT_INCOMPLETE","error":"truncated"}\n\n'+(ending==="invalid"?'event: exit\ndata: {"exit_code":null}\n\n':'')));
      if(ending!=="hang") controller.close();
    },cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}});
  }});
  try {
    const process = await runtime.spawnDuplexProcess({command:"worker"});
    const result = Promise.allSettled([bytes(process.stdout),bytes(process.stderr),process.exited]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await result)[2].status).toBe("rejected");
    if(ending==="hang") expect(cancelled).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("persists the runtime handle before acknowledging allocation ownership", async () => {
  const {createCloudflareBridgeProvider} = await import("../src/cloudflare-bridge");
  const store = new InMemoryBlobStore();
  let claims = 0;
  const provider = createCloudflareBridgeProvider({baseUrl:"https://bridge.test",apiKey:"key",checkpointStore:store, fetch: async(input,init) => {
    const path = new URL(String(input)).pathname;
    if(path === "/v1/sandbox") return Response.json({id:"allocated"});
    if(path.endsWith("/claim")) {
      claims++;
      const row = await store.get("cloudflare-bridge-workspaces/allocations/allocated.json");
      expect(row).not.toBeNull();
      expect(JSON.parse(await row!.text())).toMatchObject({provider:"cloudflare-sandbox-bridge",runtimeId:"allocated"});
      return new Response(null,{status:204});
    }
    return new Response(null,{status:204});
  }});
  await provider.create({sessionId:"session",workdir:"/workspace"},{});
  expect(claims).toBe(1);
});

it.each(["http", "not-sse"])("kills allocated process if events connection fails: %s", async failure => {
 let running=false;
 const store=new InMemoryBlobStore();
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async(input,init)=>{
   const path=new URL(String(input)).pathname;
   if(path.endsWith("/process")){running=true;return Response.json({id:"orphan"});}
   if(path.endsWith("/events"))return new Response("failed",{status:failure==="http"?503:200,headers:{"content-type":"text/plain"}});
   if(path.endsWith("/signal")){expect(JSON.parse(String(init?.body))).toEqual({signal:"SIGKILL"});running=false;return Response.json({exit_code:137});}
   return new Response(null,{status:204});
 }});
 await expect(runtime.spawnDuplexProcess({command:"sleep",args:["120"]})).rejects.toThrow();
 expect(running).toBe(false);
});
it("does not wait for a non-SSE body cancellation before killing the process", async () => {
 let killed = false;
 let releaseCancel!: () => void;
 const cancellation = new Promise<void>(resolve => { releaseCancel = resolve; });
 const runtime = new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:new InMemoryBlobStore(),fetch:async input => {
   if(String(input).endsWith("/process")) return Response.json({id:"pending-cancel"});
   if(String(input).endsWith("/events")) return new Response(new ReadableStream({cancel:()=>cancellation}),{headers:{"content-type":"text/plain"}});
   if(String(input).endsWith("/signal")){killed=true;return Response.json({exit_code:137});}
   return new Response(null,{status:204});
 }});
 const settled = runtime.spawnDuplexProcess({command:"sleep"}).catch(error=>error);
 try { await vi.waitFor(()=>expect(killed).toBe(true),{timeout:100}); }
 finally { releaseCancel(); }
 await expect(settled).resolves.toBeInstanceOf(Error);
});

it.each(["request", "body"])("records cleanup identity before waiting for a hanging signal %s and bounds confirmation", async hang => {
 vi.useFakeTimers();
 const store = new InMemoryBlobStore();
 const path = "cloudflare-bridge-workspaces/processes/sandbox/pending.json";
 let entered = false;
 let persistedBeforeSignal = false;
 let signal: AbortSignal | null | undefined;
 const runtime = new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async(input,init)=>{
   if(String(input).endsWith("/process"))return Response.json({id:"pending"});
   if(String(input).endsWith("/events"))return new Response("not-sse");
   if(String(input).endsWith("/signal")){
     entered = true; signal=init?.signal;
     persistedBeforeSignal = await store.get(path) !== null;
     return hang === "request" ? new Promise<Response>(()=>{}) : new Response(new ReadableStream({pull:()=>new Promise(()=>{})}),{headers:{"content-type":"application/json"}});
   }
   return new Response(null,{status:204});
 }});
 let result: unknown;
 const spawning=runtime.spawnDuplexProcess({command:"sleep"}).catch(error=>{result=error;});
 try {
   await vi.waitFor(() => expect(entered).toBe(true));
   expect(persistedBeforeSignal).toBe(true);
   await vi.advanceTimersByTimeAsync(60_000);
   expect(result).toMatchObject({runtimeId:"sandbox",processId:"pending",recorded:true});
   expect(signal?.aborted).toBe(true);
   const record=await store.get(path);
   expect(JSON.parse(await record!.text())).toMatchObject({state:"cleanup_unconfirmed"});
   await spawning;
 } finally { vi.useRealTimers(); }
});

it("removes the pending cleanup identity only after confirmed exit", async () => {
 const store=new InMemoryBlobStore();
 const path="cloudflare-bridge-workspaces/processes/sandbox/confirmed.json";
 let recordedAtSignal=false;
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async input=>{
   if(String(input).endsWith("/process"))return Response.json({id:"confirmed"});
   if(String(input).endsWith("/signal")){recordedAtSignal=await store.get(path)!==null;return Response.json({exit_code:137});}
   return new Response("unavailable",{status:503});
 }});
 await expect(runtime.spawnDuplexProcess({command:"sleep"})).rejects.toThrow();
 expect(recordedAtSignal).toBe(true);
 expect(await store.get(path)).toBeNull();
});

it.each(["throws", "hangs", "refuses"])("exposes process identity and still attempts bounded cleanup when storage %s", async mode => {
 vi.useFakeTimers();
 const store=new InMemoryBlobStore();
 store.put=async()=>{
   if(mode==="throws")throw new Error("store unavailable");
   if(mode==="hangs")return new Promise(()=>{});
   return null;
 };
 let killed=false;
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async input=>{
   if(String(input).endsWith("/process"))return Response.json({id:"recoverable"});
   if(String(input).endsWith("/signal")){killed=true;return new Promise(()=>{});}
   return new Response("unavailable",{status:503});
 }});
 let result: unknown;
 const spawning=runtime.spawnDuplexProcess({command:"sleep"}).catch(error=>{result=error;});
 try {
   await vi.advanceTimersByTimeAsync(60_000);
   expect(killed).toBe(true);
   expect(result).toMatchObject({runtimeId:"sandbox",processId:"recoverable",recorded:false});
   await spawning;
 } finally { vi.useRealTimers(); }
});

it("starts cleanup without reading a hanging non-2xx events error body", async () => {
 let killed=false;
 let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:new InMemoryBlobStore(),fetch:async input=>{
   if(String(input).endsWith("/process"))return Response.json({id:"error-body"});
   if(String(input).endsWith("/events"))return new Response(new ReadableStream({async start(controller){await pending;controller.close();}}),{status:503});
   if(String(input).endsWith("/signal")){killed=true;return Response.json({exit_code:137});}
   return new Response(null,{status:204});
 }});
 const spawning=runtime.spawnDuplexProcess({command:"sleep"}).catch(error=>error);
 try { await vi.waitFor(()=>expect(killed).toBe(true),{timeout:100}); }
 finally { finish(); }
 await expect(spawning).resolves.toBeInstanceOf(Error);
});

it.each(["before-write", "after-write"])("late cleanup identity PUT cannot replace confirmed exit: %s", async timing => {
 vi.useFakeTimers();
 const store=new InMemoryBlobStore();
 const put=store.put.bind(store);
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let pendingPut: ReturnType<typeof put> | undefined;
 // Fake timers fire the 5 s cleanup bound on every storage step while the
 // in-memory store still hashes on real async crypto, so the terminal
 // tombstone PUT can outlive its bound. It is not cancelled and still
 // commits: read the final state only once every issued write has settled.
 const writes: Promise<unknown>[]=[];
 store.put=(key,body,options)=>{
   if(JSON.parse(String(body)).state!=="cleanup_unconfirmed"){const write=put(key,body,options);writes.push(write);return write;}
   pendingPut=(async()=>{
     if(timing==="before-write")await gate;
     const result=await put(key,body,options);
     if(timing==="after-write")await gate;
     return result;
   })();
   return pendingPut;
 };
 const path="cloudflare-bridge-workspaces/processes/sandbox/late.json";
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async input=>{
   if(String(input).endsWith("/process"))return Response.json({id:"late"});
   if(String(input).endsWith("/signal"))return Response.json({exit_code:137});
   return new Response("failed",{status:503});
 }});
 let result: unknown;
 const spawning=runtime.spawnDuplexProcess({command:"sleep"}).catch(error=>{result=error;});
 try {
   await vi.advanceTimersByTimeAsync(30_000);
   expect(result).toMatchObject({cleanupConfirmed:true,recorded:false});
   release(); await pendingPut; await spawning; await Promise.allSettled(writes);
   expect(writes.length).toBeGreaterThan(0);
   const record=await store.get(path);
   expect(record===null?null:JSON.parse(await record.text()).state).not.toBe("cleanup_unconfirmed");
 } finally { release(); vi.useRealTimers(); }
});

it("retains recoverable process identity when events and cleanup both fail", async () => {
 const store=new InMemoryBlobStore();
 const runtime=new CloudflareBridgeRuntime({baseUrl:"https://bridge.test",apiKey:"key",runtimeId:"sandbox",checkpointStore:store,fetch:async(input)=>String(input).endsWith("/process")?Response.json({id:"unconfirmed"}):new Response("unavailable",{status:503})});
 await expect(runtime.spawnDuplexProcess({command:"sleep"})).rejects.toThrow("cleanup unconfirmed");
 const record=await store.get("cloudflare-bridge-workspaces/processes/sandbox/unconfirmed.json");
 expect(record).not.toBeNull();
 expect(JSON.parse(await record!.text())).toMatchObject({runtimeId:"sandbox",processId:"unconfirmed",state:"cleanup_unconfirmed"});
});
