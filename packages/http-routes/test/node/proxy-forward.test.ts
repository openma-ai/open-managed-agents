import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyUpstream } from "../../src/proxy/forward";

interface Seen {
  method?: string;
  headers?: IncomingHttpHeaders;
  body?: string;
}

describe("proxyUpstream", () => {
  let base = "";
  let seen: Seen = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen = { method: req.method, headers: req.headers, body };
      if (req.url === "/gzip") {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "keep-alive": "timeout=5",
        }).end(gzipSync('{"ok":true}'));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.example/" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "1" }).end('{"ok":true}');
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards through Node fetch when the caller sent hop-by-hop headers", async () => {
    // Regression: forwarding these verbatim made Node's fetch throw
    // "fetch failed" (UND_ERR_INVALID_ARG / UND_ERR_NOT_SUPPORTED), which
    // surfaced as a 500 from the MCP proxy before the upstream was reached.
    const response = await proxyUpstream({
      url: `${base}/mcp`,
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        connection: "keep-alive, x-hop",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        expect: "100-continue",
        te: "trailers",
        "x-hop": "1",
        host: "openma.example",
        "content-length": "999",
        "mcp-session-id": "s-1",
      }),
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(200);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"jsonrpc":"2.0"}');
    expect(seen.headers?.["mcp-session-id"]).toBe("s-1");
    expect(seen.headers?.accept).toBe("application/json, text/event-stream");
    expect(seen.headers?.["x-hop"]).toBeUndefined();
    expect(seen.headers?.upgrade).toBeUndefined();
    expect(seen.headers?.expect).toBeUndefined();
    expect(seen.headers?.host).toBe(new URL(base).host);
    expect(response.headers.get("x-upstream")).toBe("1");
  });

  it("injects set headers and withholds dropped caller headers", async () => {
    await proxyUpstream({
      url: `${base}/mcp`,
      method: "POST",
      headers: new Headers({
        authorization: "Bearer caller-token",
        "x-api-key": "openma-key",
        cookie: "s=1",
        "x-oma-session": "sess",
        "x-keep": "yes",
      }),
      body: "{}",
      set: { authorization: "Bearer vault-token" },
      drop: ["x-api-key", "cookie"],
      dropPrefixes: ["x-oma-"],
    });
    expect(seen.headers?.authorization).toBe("Bearer vault-token");
    expect(seen.headers?.["x-api-key"]).toBeUndefined();
    expect(seen.headers?.cookie).toBeUndefined();
    expect(seen.headers?.["x-oma-session"]).toBeUndefined();
    expect(seen.headers?.["x-keep"]).toBe("yes");
  });

  it("returns a decoded body without the stale encoding or hop-by-hop headers", async () => {
    const response = await proxyUpstream({ url: `${base}/gzip`, method: "GET", headers: new Headers() });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("keep-alive")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it("does not follow redirects", async () => {
    const response = await proxyUpstream({ url: `${base}/redirect`, method: "GET", headers: new Headers() });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elsewhere.example/");
  });

  it("can replay the same buffered body", async () => {
    const body = new TextEncoder().encode('{"n":1}');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await proxyUpstream({ url: `${base}/mcp`, method: "POST", headers: new Headers(), body });
      expect(response.status).toBe(200);
      expect(seen.body).toBe('{"n":1}');
    }
  });
});
