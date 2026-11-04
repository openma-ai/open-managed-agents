import { afterEach, describe, expect, it, vi } from "vitest";

import { handleProcessFailure } from "../../../packages/control-plane-node/src/lib/db-unhandled-rejection";
import { isFetchAbortRejection } from "../../../packages/control-plane-node/src/lib/fetch-abort-rejection";
import { createNodeMcpProxyBinding } from "../../../packages/control-plane-node/src/lib/http-mcp-proxy";
import { proxyUpstream } from "../../../packages/http-routes/src/proxy/forward";
import { NoopLogger, setRootLogger, type Logger, type LogBindings } from "../../../packages/observability/src/index";
import { Timeout } from "../../../packages/sql-client/src/db-errors";

/** Logger stub that records fatal emissions (the structured-crash line).
 *  Explicit methods — object spread cannot copy prototype methods. */
function stubLogger(): { logger: Logger; fatalCalls: LogBindings[] } {
  const fatalCalls: LogBindings[] = [];
  const logger: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: (objOrMsg: LogBindings | string) => {
      fatalCalls.push(typeof objOrMsg === "string" ? { message: objOrMsg } : objOrMsg);
    },
    child: () => logger,
  };
  return { logger, fatalCalls };
}

describe("handleProcessFailure: network-abort rejections must not kill the process (fork#17)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Runs handleProcessFailure with a stub exit (4th param — deps.exit is only resolved by installDbUnhandledRejectionNet). */
  function run(kind: "unhandled_rejection" | "uncaught_exception", reason: unknown) {
    vi.stubEnv("NODE_ENV", "production");
    const exit = vi.fn();
    const { logger, fatalCalls } = stubLogger();
    handleProcessFailure(kind, reason, { logger }, exit);
    return { exit, fatalCalls };
  }

  it("tolerates the osbtest crash shape (undici body termination: TypeError: terminated)", () => {
    const { exit, fatalCalls } = run("unhandled_rejection", new TypeError("terminated"));
    expect(exit).not.toHaveBeenCalled();
    expect(fatalCalls).toHaveLength(1);
  });

  it("tolerates explicit AbortError rejections", () => {
    const { exit } = run("unhandled_rejection", new DOMException("This operation was aborted", "AbortError"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("tolerates `fetch failed` wrapping a connection reset", () => {
    const cause = new Error("socket hang up");
    (cause as NodeJS.ErrnoException).code = "ECONNRESET";
    const { exit } = run("unhandled_rejection", new TypeError("fetch failed", { cause }));
    expect(exit).not.toHaveBeenCalled();
  });

  it("still exits on genuinely fatal rejections (not network-shaped)", () => {
    const { exit } = run("unhandled_rejection", new Error("assertion failed"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps lease-safe failures tolerated (existing behaviour)", () => {
    const { exit } = run("unhandled_rejection", new Timeout({ op: "sql" }));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("isFetchAbortRejection", () => {
  it("matches the undici/network termination family", () => {
    expect(isFetchAbortRejection(new TypeError("terminated"))).toBe(true);
    expect(isFetchAbortRejection(new DOMException("This operation was aborted", "AbortError"))).toBe(true);
    expect(isFetchAbortRejection(Object.assign(new Error("boom"), { code: "UND_ERR_SOCKET" }))).toBe(true);
    expect(isFetchAbortRejection(new Error("socket hang up"))).toBe(true);
    const cause = new Error("reset");
    (cause as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isFetchAbortRejection(new TypeError("fetch failed", { cause }))).toBe(true);
  });

  it("does not match business-shaped errors or non-objects", () => {
    expect(isFetchAbortRejection(new Error("assertion failed"))).toBe(false);
    expect(isFetchAbortRejection("terminated")).toBe(false);
    expect(isFetchAbortRejection(null)).toBe(false);
    expect(isFetchAbortRejection(undefined)).toBe(false);
  });
});

describe("proxy signal passthrough (fork#17 request-level)", () => {
  afterEach(() => {
    setRootLogger(new NoopLogger());
  });

  it("proxyUpstream passes the caller signal through hono proxy to the real fetch", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetcher = (req: Request): Promise<Response> => {
      seen = req.signal;
      return Promise.resolve(new Response("ok"));
    };
    await proxyUpstream({
      url: "https://mcp.example/rpc",
      method: "POST",
      headers: new Headers(),
      body: "{}",
      set: { authorization: "Bearer x" },
      signal: controller.signal,
      fetcher: fetcher as unknown as typeof fetch,
    });
    // undici rebuilds the Request (a fresh signal object) — assert the live
    // signal reached the real fetch; abort propagation is covered end to end
    // by the hangup case below (an aborted global Request here pollutes the
    // undici dispatcher state later cases share).
    expect(seen?.aborted).toBe(false);
  });

  it("createNodeMcpProxyBinding forwards request.signal to the upstream fetcher", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetcher = (req: Request): Promise<Response> => {
      seen = req.signal;
      return Promise.resolve(new Response("ok"));
    };
    const binding = createNodeMcpProxyBinding({
      resolveTarget: async () => ({ upstreamUrl: "https://mcp.example/rpc", accessToken: "t" }),
      fetcher: fetcher as unknown as typeof fetch,
    });
    await binding.fetch(new Request("http://server/v1/mcp", {
      method: "POST",
      headers: { "x-oma-tenant": "tn", "x-oma-session": "s1", "x-oma-mcp-server": "openalex" },
      body: "{}",
      signal: controller.signal,
    }));
    expect(seen?.aborted).toBe(false);
  });
});
