import { describe, expect, it } from "vitest";
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
