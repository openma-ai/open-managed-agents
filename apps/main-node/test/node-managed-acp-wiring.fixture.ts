import { Disposables } from "../../../packages/control-plane-node/src/lifecycle.js";
import { createNodeRuntime } from "../../../packages/control-plane-node/src/modules/node-runtime.js";
import { mountNodeHttp } from "../../../packages/control-plane-node/src/modules/node-http.js";
import { SqlSessionSource, SqlSessionEnvironmentSource } from "@open-managed-agents/managed-agents-adapters-sql";
import { environmentWorkSandboxTokenRef } from "../../../packages/sandbox-gateway-sql/src/index.js";
import { sandboxTokenSha256 } from "../../../packages/sandbox-gateway/src/index.js";
import { runNodeWorkItemCli } from "../../../packages/harness-runtime-acp/src/node-work-item-cli.js";
import { createDefaultWorkComposition, type WorkRuntimeModules } from "../../../packages/harness-runtime-acp/src/node-work-composition.js";
import { SandboxSpawner } from "../../../packages/acp-runtime/src/spawners/sandbox.js";
import type { nodeDefaults } from "../src/components.js";
import { expect } from "vitest";

/** Real Work entry for this suite only. Selection, poll, ACK, bootstrap,
 * consumption, model/MCP authority and finalization all stay production code.
 * Candidate source is explicit, never an installed package alias. */
export async function createWiringControl(components: Awaited<ReturnType<typeof nodeDefaults>>) {
  const disposables = new Disposables();
  const runtime = await createNodeRuntime(components, disposables, { current: null });
  const app = await mountNodeHttp(runtime, disposables, runtime.workFinalizationHost);
  const active: Array<{ controller: AbortController; result: Promise<void>; handle: Awaited<ReturnType<ReturnType<typeof runtime.sessionSandboxes.build>["startManagedProcess"]>>; sandbox: ReturnType<typeof runtime.sessionSandboxes.build> }> = [];
  let delivered: { environmentId: string; workId: string } | undefined;
  const modules = async (): Promise<WorkRuntimeModules | undefined> => {
    const candidate = process.env.OPENMA_COMMON_CANDIDATE;
    if (!candidate) return undefined;
    const common = await import(/* @vite-ignore */ candidate + "/src/managed-runtime/index.ts");
    const modes = await import(/* @vite-ignore */ candidate + "/src/acp-runtime/permission-mapping.ts");
    const { AcpRuntimeImpl } = await import(/* @vite-ignore */ candidate + "/src/acp-runtime/runtime.ts");
    return { control: { createSupervisor: common.createManagedAcpSupervisorHarness, createControlChannel: common.createManagedHarnessHttpControlChannel, applyPermissionMode: modes.applyAcpPermissionMode }, createAcpRuntime: spawner => new AcpRuntimeImpl(spawner) };
  };
  const fetch: typeof globalThis.fetch = async (raw, init) => app.fetch(new Request(raw, init));
  const admin = async (path: string) => {
    const response = await fetch(components.config.http.publicBaseUrl! + path, { headers: { "x-api-key": "test-admin", "Anthropic-Worker-ID": "wiring-worker" } });
    const value = await response.json() as any;
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  return {
    components,
    fetch: (request: Request) => app.fetch(request),
    async startWork(environmentId: string, sessionId: string, agent: { command: string; args: string[]; env: Record<string,string>; cwd: string; id: string }) {
      const work = await admin(`/v1/environments/${environmentId}/work/poll?block_ms=1`);
      if (!work) throw new Error("No dispatchable Environment Work");
      delivered = { environmentId, workId: work.id };
      const scope = { workspaceId: "default", environmentId, sessionId, workId: work.id };
      const stored = await runtime.managedEnvironmentWorkStore.find(scope);
      if (!stored?.claim) throw new Error("Missing polled Work claim");
      const claim = { ...scope, generation: stored.claim.generation };
      const session = (await new SqlSessionSource(runtime.sql).find(scope))!;
      const environment = (await new SqlSessionEnvironmentSource(runtime.sql).find(scope))!;
      let holderHash: string | undefined;
      const current = async () => {
        const row = await runtime.managedEnvironmentWorkStore.find(scope);
        return row?.claim?.generation === claim.generation && row.claim.workerId === stored.claim!.workerId
          && ["queued", "starting", "active", "stopping"].includes(row.work.state) && Date.parse(row.claim.claimedAt) + row.heartbeatTtlSeconds * 1000 > Date.now();
      };
      const sandbox = runtime.sessionSandboxes.build({ workspaceId: "default", session, environment, workAuthority: {
        attempt: environmentWorkSandboxTokenRef(claim), isCurrent: current, holderHash: () => holderHash,
        token: physical => runtime.managedAcpCapabilities.issueWork(claim, session.agent.openma?.harness, physical),
      } });
      await sandbox.open();
      const token = await sandbox.workToken(); holderHash = (await sandboxTokenSha256(token))!;
      const runtimeModules = await modules();
      const handle = await sandbox.startManagedProcess({ command: "/bin/sleep", args: ["120"], env: {} });
      if (await handle.getStatus() !== "running") { await handle.kill("SIGKILL"); throw new Error("Management process did not remain running"); }
      const env = { ANTHROPIC_BASE_URL: components.config.http.publicBaseUrl!, ANTHROPIC_ENVIRONMENT_ID: environmentId,
        ANTHROPIC_SESSION_ID: sessionId, ANTHROPIC_WORK_ID: work.id, ANTHROPIC_WORK_SECRET: work.secret,
        OPENMA_HARNESS_ID: "acp", OPENMA_SANDBOX_TOKEN: token };
      const controller = new AbortController();
      const composition = createDefaultWorkComposition({ environment: env, fetch, modules: runtimeModules,
        spawner: new SandboxSpawner(sandbox), stateIo: {
          readFile: path => sandbox.readFile(path), writeFile: async (path, value) => { await sandbox.writeFile(path, value); },
          writeFileBytes: async (path, value) => { await sandbox.writeFileBytes!(path, value); }, exec: command => sandbox.exec(command),
        } });
      let failure: unknown;
      const responses: Array<{action:string;status:number;body:unknown}> = [];
      let published = 0;
      const result = runNodeWorkItemCli({ environment: env, signal: controller.signal, heartbeatIntervalMs: 50,
        fetch: async (raw, init) => { const response = await fetch(raw, init); if (!response.ok && !String(raw).includes("heartbeat")) responses.push({action:new URL(String(raw)).pathname.split("/").at(-1)!,status:response.status,body:await response.clone().json().catch(()=>null)}); if (String(raw).endsWith("work-publish") && response.ok) published++; return response; },
        composition: async context => ({ ...await composition(context), resolveAgent: () => agent }),
      }).catch(error => { failure = error; console.error("WIRING RUNNER FAILURE",error,"HTTP failures",responses); throw error; });
      void result.catch(() => undefined);
      active.push({ controller, result, handle, sandbox });
      return {
        result,
        async publication(count=1) { await expect.poll(() => { if (failure) throw failure; return published; }, {timeout:10000}).toBe(count); },
      };
    },
    async retire() {
      for (const item of active.splice(0)) {
        item.controller.abort(new Error("test process restart")); await item.result.catch(() => undefined);
        await item.handle.kill("SIGKILL"); expect(await item.handle.getStatus()).not.toBe("running");
      }
      // Crash/reclaim injection only: do not synthesize a terminal through
      // Work stop or fabricate an execution row. The next real poll owns CAS.
      if (delivered) await runtime.sql.prepare("UPDATE managed_environment_work SET claim_at=0 WHERE id=?").bind(delivered.workId).run();
    },
    async stop(_reason?: string) {
      for (const item of active.splice(0)) { item.controller.abort(new Error("test cleanup")); await item.result.catch(() => undefined); await item.handle.kill("SIGKILL"); expect(await item.handle.getStatus()).not.toBe("running"); }
      await disposables.dispose();
    },
  };
}
