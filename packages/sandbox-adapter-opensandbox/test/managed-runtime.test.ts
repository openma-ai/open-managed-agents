import { afterEach, expect, it, vi } from "vitest";
import { createProviderManagedRuntime } from "@open-managed-agents/managed-runtime-sandbox";
import { sandboxProvider } from "../src/index";

afterEach(() => vi.unstubAllGlobals());

it("acquires OpenSandbox through the existing managed runtime ports and renews its lease", async () => {
  const scope = { workspaceId: "ws", environmentId: "env", sessionId: "session", workId: "work" };
  const fence = { ...scope, ownerId: "owner", generation: 1, token: "fence", expiresAt: "2099-01-01T00:00:00Z" };
  const signal = new AbortController().signal;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/endpoints/44772")) return Response.json({ endpoint: "http://exec.test" });
    if (url.endsWith("/command")) {
      return new Response('data: {"type":"stdout","text":"__OPENMA_RUNTIME_READY__"}\n\ndata: {"type":"execution_complete"}\n\n');
    }
    return Response.json({ id: "sb-1", status: { state: "Running" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const runtime = createProviderManagedRuntime({
    providerName: "opensandbox",
    provider: sandboxProvider,
    context: () => ({ sessionId: scope.sessionId, workdir: "/workspace" }),
    environment: () => ({ OPENSANDBOX_DOMAIN: "control.test", SANDBOX_IMAGE: "openma-runtime:test" }),
    leaseTtlMs: 90_000,
    sandboxCapabilities: { suspendResume: "unsupported", hardTerminate: "supported", runtimeCheckpoints: [] },
    workspace: { strategies: ["ephemeral"] },
    drivers: ["ama_worker"],
  });
  const workspace = await runtime.workspace.materialize({
    scope, fence, strategy: "ephemeral", activeCheckpoint: null, idempotencyKey: "test", signal,
  });
  const binding = await runtime.sandbox.acquire({
    scope, fence, workspace, outputs: null, signal,
    plan: {
      workspaceStrategy: "ephemeral", outputStrategy: null, runtimeCheckpoint: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
    },
  });
  expect(binding).toMatchObject({ provider: "opensandbox" });
  const creation = fetchMock.mock.calls.find(([url, init]) => url === "http://control.test/v1/sandboxes" && init?.method === "POST");
  expect(JSON.parse(creation![1]!.body as string).image).toEqual({ uri: "openma-runtime:test" });
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/renew-expiration"))).toBe(true);
});
