import { afterEach, expect, it, vi } from "vitest";
import { createProviderManagedRuntime } from "@open-managed-agents/managed-runtime-sandbox";
import { openSandboxDurableMount, sandboxProvider } from "../src/index";
import { completed, mockSdkServer } from "./sdk-http";

afterEach(() => vi.unstubAllGlobals());

it("acquires OpenSandbox through the existing managed runtime ports and renews its lease", async () => {
  const scope = { workspaceId: "ws", environmentId: "env", sessionId: "session", workId: "work" };
  const fence = { ...scope, ownerId: "owner", generation: 1, token: "fence", expiresAt: "2099-01-01T00:00:00Z" };
  const signal = new AbortController().signal;
  const server = mockSdkServer();
  server.commands = [{ type: "stdout", text: "__OPENMA_RUNTIME_READY__" }, completed];
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
  const creation = server.calls.find(call => call.url.href === "http://control.test/v1/sandboxes" && call.method === "POST");
  expect(creation!.body).toMatchObject({ image: { uri: "openma-runtime:test" } });
  expect(server.calls.some(call => call.url.pathname.endsWith("/renew-expiration"))).toBe(true);
});

it("accepts the mapped retained_runtime + checkpoint_restore + durable_mount composition", () => {
  const env = {
    OPENSANDBOX_DOMAIN: "control.test", OPENSANDBOX_RUNTIME: "docker",
    OPENSANDBOX_VOLUMES: JSON.stringify([{ name: "ws", pvc: { claimName: "oma-ws" }, mountPath: "/workspace" }]),
  };
  const runtime = createProviderManagedRuntime({
    providerName: "opensandbox",
    provider: sandboxProvider,
    context: () => ({ sessionId: "s", workdir: "/workspace" }),
    environment: () => env,
    leaseTtlMs: 90_000,
    sandboxCapabilities: { suspendResume: "supported", hardTerminate: "supported", runtimeCheckpoints: [] },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore"],
      retainedSuspendKind: "memory",
      portableCheckpointKind: "filesystem",
      durableMount: openSandboxDurableMount(env, "/workspace"),
    },
    drivers: ["ama_worker"],
  });
  expect(runtime.workspace).toBeDefined();
});
