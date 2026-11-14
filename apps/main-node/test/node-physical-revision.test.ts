import { expect, it } from "vitest";
import { coldFixture } from "./node-cold-finalization.fixture.js";
import { coldProvider } from "./node-cold-finalization-provider.fixture.js";

async function nativeRuntime(f: Awaited<ReturnType<typeof coldFixture>>) {
  const { nodeDefaults } = await import("../src/components.js");
  const { createNodeRuntime } = await import("../../../packages/control-plane-node/src/modules/node-runtime.js");
  const { Disposables } = await import("../../../packages/control-plane-node/src/lifecycle.js");
  const provider = await coldProvider(f);
  const disposables = new Disposables();
  const components = await nodeDefaults(
    { ...f.config, execution: { ...f.config.execution, ownerId: "native-revision-test" } },
    { sessionSandboxAdapter: provider.adapter },
  );
  const runtime = await createNodeRuntime(components, disposables, { current: null });
  return { provider, disposables, runtime };
}

async function sandboxState(f: Awaited<ReturnType<typeof coldFixture>>) {
  const row = await f.sql.prepare('SELECT value FROM kv_entries WHERE tenant_id=? AND "key"=?')
    .bind("default", `session_sandbox_state:${f.session.id}`)
    .first<{ value: string }>();
  return row ? JSON.parse(row.value) as any : null;
}

it("local Node providers fail closed without inventing a tar archive", async () => {
  const f = await coldFixture();
  const result = await f.request("checkpoint");
  expect(result.status).toBe(502);
  expect(await result.json()).toMatchObject({ type: "failed" });
  expect(await sandboxState(f)).toMatchObject({ latestSnapshot: { status: "none" } });
  expect(await f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_session_workspace_checkpoints'").first()).toBeNull();
});

it("native Node providers record a complete snapshot and never write a workspace archive", async () => {
  const f = await coldFixture();
  const { provider, disposables, runtime } = await nativeRuntime(f);
  try {
    const result = await runtime.workFinalizationHost.prepare({
      claim: f.claim,
      turnId: f.turnId,
      revision: f.revision,
      isCurrent: async () => true,
    });
    expect(result).toMatchObject({ type: "prepared" });
    expect(await sandboxState(f)).toMatchObject({
      latestSnapshot: {
        status: "taken",
        ref: { provider: "e2b", kind: "snapshot", metadata: { kind: "container" } },
      },
    });
    expect(await f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_session_workspace_checkpoints'").first()).toBeNull();
  } finally {
    await disposables.dispose();
    await provider.close();
  }
});

it("native Node finalization refuses a lost management process before snapshot", async () => {
  const f = await coldFixture();
  const { provider, disposables, runtime } = await nativeRuntime(f);
  provider.locator.status = "unknown";
  try {
    await expect(runtime.workFinalizationHost.prepare({
      claim: f.claim,
      turnId: f.turnId,
      revision: f.revision,
      isCurrent: async () => true,
    })).rejects.toThrow();
    expect(await sandboxState(f)).not.toMatchObject({ latestSnapshot: { status: "taken" } });
  } finally {
    await disposables.dispose();
    await provider.close();
  }
});
