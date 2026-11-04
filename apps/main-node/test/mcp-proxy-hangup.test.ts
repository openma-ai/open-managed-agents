/** End-to-end hangup regression: the client (harness/sandbox) disappears
 *  mid-flight, the upstream fetcher surfaces the abort deterministically,
 *  and the proxy rethrows instead of leaving an orphan rejection. Kept in
 *  its own file — sharing a worker with completed-binding cases hung this
 *  scenario (undici module state), and file isolation keeps it deterministic. */
import { afterEach, describe, expect, it } from "vitest";

import { createNodeMcpProxyBinding } from "../../../packages/control-plane-node/src/lib/http-mcp-proxy";
import { NoopLogger, setRootLogger } from "../../../packages/observability/src/index";

describe("mcp proxy client hangup", () => {
  afterEach(() => {
    setRootLogger(new NoopLogger());
  });

  it("client hangup mid-flight rejects deterministically, not an orphan rejection", async () => {
    const controller = new AbortController();
    let entered = false;
    const fetcher = (req: Request): Promise<Response> => new Promise((_resolve, reject) => {
      entered = true;
      const fail = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (req.signal.aborted) {
        fail();
        return;
      }
      req.signal.addEventListener("abort", fail);
    });
    setRootLogger(new NoopLogger());
    const binding = createNodeMcpProxyBinding({
      resolveTarget: async () => ({ upstreamUrl: "https://mcp.example/rpc", accessToken: "t" }),
      fetcher: fetcher as unknown as typeof fetch,
      accessLoss: undefined,
    });
    const promise = binding.fetch(new Request("http://server/v1/mcp", {
      method: "POST",
      headers: { "x-oma-tenant": "tn", "x-oma-session": "s1", "x-oma-mcp-server": "openalex" },
      body: "{}",
      signal: controller.signal,
    }));
    // Abort only once the proxy hop is fully in flight (fetcher holds a
    // pending upstream promise) — an earlier abort legitimately fails at
    // body read before any proxying happens.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(entered).toBe(true);
    controller.abort();
    await expect(promise).rejects.toThrow();
  }, 15000);
});
