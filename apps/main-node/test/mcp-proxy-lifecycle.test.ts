import { Hono } from "hono";
import { createServer } from "node:http";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createNodeMcpProxyBinding, buildNodeHttpMcpProxyRoutes, type NodeHttpMcpProxyDependencies } from "../../../packages/control-plane-node/src/lib/http-mcp-proxy";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(kind: "binding" | "route", dependencies: NodeHttpMcpProxyDependencies) {
  if (kind === "binding") return createNodeMcpProxyBinding(dependencies).fetch;
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", "workspace"); await next(); });
  // The server owns pre-header failures; body failures stay on its response.
  app.onError(() => new Response("upstream failed", { status: 502 }));
  app.route("/mcp", buildNodeHttpMcpProxyRoutes(dependencies));
  return (request: Request) => Promise.resolve(app.fetch(request));
}
function request(signal?: AbortSignal) {
  return new Request("http://host/mcp/session/server", { method: "POST", body: "{}", signal,
    headers: { "x-oma-tenant": "workspace", "x-oma-session": "session", "x-oma-mcp-server": "server" } });
}

describe.each(["binding", "route"] as const)("MCP request and body ownership: %s", kind => {
  it("cancels the actual upstream request before headers, using an explicit dispatch handshake", async () => {
    const controller = new AbortController(); const entered = deferred(); const aborted = deferred();
    const requests: Request[] = []; // Keep Requests/signals alive through cancellation.
    const fetcher = ((upstream: Request) => {
      requests.push(upstream); entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => { aborted.resolve(); reject(upstream.signal.reason); };
        upstream.signal.addEventListener("abort", cancel, { once: true });
        if (upstream.signal.aborted) cancel();
      });
    }) as typeof fetch;
    const send = setup(kind, { resolveTarget: async () => ({ upstreamUrl: "https://upstream/mcp", accessToken: null }), fetcher });
    const inbound = request(controller.signal);
    const outcome = send(inbound).catch(error => error);
    await entered.promise; controller.abort(new Error("client disconnected")); await aborted.promise;
    expect(requests[0]!.signal.aborted).toBe(true);
    const result = await outcome;
    if (kind === "binding") expect(result).toBeInstanceOf(Error);
    else expect(result.status).toBe(502);
  }, 3000);

  it("keeps cancellation attached after headers and rejects an interrupted SSE body", async () => {
    const controller = new AbortController(); const cancelled = vi.fn(); const requests: Request[] = [];
    const fetcher = (async (upstream: Request) => {
      requests.push(upstream);
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel: cancelled }),
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const send = setup(kind, { resolveTarget: async () => ({ upstreamUrl: "https://upstream/mcp", accessToken: null }), fetcher });
    const inbound = request(controller.signal); const response = await send(inbound);
    const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false);
    const pending = reader.read().catch(error => error);
    controller.abort(new Error("client disconnected after headers"));
    expect(await pending).toBeInstanceOf(Error); expect(requests[0]!.signal.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("observes upstream body failure even before the caller reads, and never returns truncated success", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { upstream = c; } }))) as typeof fetch;
    const send = setup(kind, { resolveTarget: async () => ({ upstreamUrl: "https://upstream/mcp", accessToken: null }), fetcher });
    const response = await send(request()); const failure = new TypeError("terminated");
    upstream.error(failure); await Promise.resolve();
    await expect(response.text()).rejects.toBe(failure);
  });

  it("aborts a refresh exchange and never sends the original business request again", async () => {
    const controller = new AbortController(); const refreshEntered = deferred(); const refreshAborted = deferred();
    let sends = 0;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { sends++; return Promise.resolve(new Response("expired", { status: 401 })); }
      refreshEntered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { refreshAborted.resolve(); reject(init!.signal!.reason); }, { once: true });
      });
    }) as typeof fetch;
    const send = setup(kind, { resolveTarget: async () => ({ upstreamUrl: "https://upstream/mcp", accessToken: "old",
      refresh: { refreshToken: "refresh", tokenEndpoint: "https://oauth/token" } }), fetcher });
    const inbound = request(controller.signal); const outcome = send(inbound).catch(error => error);
    await refreshEntered.promise; controller.abort(); await refreshAborted.promise; await outcome;
    expect(sends).toBe(1);
  }, 3000);
});

it("propagates a real upstream socket termination after headers to the owning response reader", async () => {
  const sent = deferred<import("node:http").ServerResponse>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n"); sent.resolve(res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("No address");
    const binding = createNodeMcpProxyBinding({ resolveTarget: async () => ({
      upstreamUrl: `http://127.0.0.1:${address.port}/mcp`, accessToken: null,
    }) });
    const response = await binding.fetch(request()); const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const pending = reader.read(); const observed = pending.catch(error => error);
    (await sent.promise).destroy(); expect(await observed).toBeInstanceOf(Error);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("a real downstream disconnect cancels the public Node route's upstream stream", async () => {
  const upstreamClosed = deferred();
  const upstream = createServer((_req, res) => {
    res.on("close", () => upstreamClosed.resolve());
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: alive\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("No upstream address");
  const send = setup("route", { resolveTarget: async () => ({ upstreamUrl: `http://127.0.0.1:${address.port}/mcp`, accessToken: null }) });
  const listening = deferred<number>();
  const proxy = serve({ fetch: send, port: 0, hostname: "127.0.0.1" }, info => listening.resolve(info.port));
  const controller = new AbortController();
  try {
    const port = await listening.promise;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/session/server`, { method: "POST", body: "{}", signal: controller.signal });
    const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false);
    const pending = reader.read().catch(error => error);
    controller.abort(); await pending; await upstreamClosed.promise;
  } finally {
    controller.abort(); proxy.closeAllConnections?.();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 5000);
