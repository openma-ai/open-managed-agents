import { expect, it } from "vitest";
import { coldFixture } from "./node-cold-finalization.fixture.js";
import { coldProvider } from "./node-cold-finalization-provider.fixture.js";

it("cold LocalSubprocess explicitly refuses a reconnect without a native provider snapshot", async () => {
  const f = await coldFixture();
  const { nodeDefaults } = await import("../src/components.js");
  const { createNodeRuntime } = await import("../../../packages/control-plane-node/src/modules/node-runtime.js");
  const { Disposables } = await import("../../../packages/control-plane-node/src/lifecycle.js");
  const disposables = new Disposables();
  try {
    const runtime = await createNodeRuntime(await nodeDefaults(f.config), disposables, { current: null });
    await expect(runtime.workFinalizationHost.prepare({ claim: f.claim, turnId: f.turnId, revision: f.revision, isCurrent: async () => true }))
      .rejects.toThrow(/Trusted Work process reconnect unsupported/);
  } finally { await disposables.dispose(); }
});

it("cold E2B finalization publishes a complete container snapshot and never writes a workspace archive", async () => {
  const f = await coldFixture();
  const provider = await coldProvider(f);
  try {
    const { nodeDefaults } = await import("../src/components.js");
    const { createNodeRuntime } = await import("../../../packages/control-plane-node/src/modules/node-runtime.js");
    const { Disposables } = await import("../../../packages/control-plane-node/src/lifecycle.js");
    const disposables = new Disposables();
    const runtime = await createNodeRuntime(await nodeDefaults({ ...f.config, execution: { ...f.config.execution, ownerId: "cold-node-B" } }, { sessionSandboxAdapter: provider.adapter }), disposables, { current: null });
    const result = await runtime.workFinalizationHost.prepare({ claim: f.claim, turnId: f.turnId, revision: f.revision, isCurrent: async () => true });
    expect(result).toMatchObject({ type: "prepared" });
    const stateRow = await f.sql.prepare("SELECT value FROM kv_entries WHERE tenant_id=? AND \"key\"=?")
      .bind("default", `session_sandbox_state:${f.session.id}`).first<{ value: string }>();
    const state = JSON.parse(stateRow!.value);
    expect(state.latestSnapshot).toMatchObject({ status: "taken", ref: { provider: "e2b", kind: "snapshot", metadata: { kind: "container" } } });
    const archiveTable = await f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_session_workspace_checkpoints'").first();
    expect(archiveTable).toBeNull();
    await disposables.dispose();
  } finally { await provider.close(); }
});
