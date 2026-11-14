import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { readCfWorkLeaseRuntime } from "../../../apps/agent/src/runtime/cf-work-lease-connection";

it("real installed SDK uses GET only to rebuild a lease client, then explicit setTimeout alone renews", async () => {
  const seen: Array<{method:string;path:string;body:unknown}> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    seen.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : null });
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ sandboxID: "physical", state: "running", lifecycle: { autoResume: false }, envdVersion: "0.3.0", envdAccessToken: "envd-test", domain: "example.test" })); }
    else { res.statusCode = 204; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("no port");
  vi.stubEnv("E2B_API_URL",`http://127.0.0.1:${address.port}`);
  try {
    const runtime = await readCfWorkLeaseRuntime({ E2B_API_KEY: "synthetic", E2B_DOMAIN: "example.test" }, "physical");
    expect(seen).toEqual([{ method: "GET", path: "/sandboxes/physical", body: null }]);
    await runtime.renewLease({ ttlMs: 360_000 });
    expect(seen).toEqual([{ method: "GET", path: "/sandboxes/physical", body: null }, { method: "POST", path: "/sandboxes/physical/timeout", body: { timeout: 360 } }]);
  } finally { vi.unstubAllEnvs(); await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
