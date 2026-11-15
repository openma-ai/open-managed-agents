import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { SessionDO } from "../src/runtime/session-do";

it.each([false, true])("canonical Memory sees this turn's copy-sync bytes, without publishing outputs (write-back fails: %s)", async fail => {
  const stub = env.SESSION_DO!.get(env.SESSION_DO!.idFromName("memory-checkpoint-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    let projection = "";
    let canonical = "";
    let publications = 0;
    let reconciliations = 0;
    const instance: any = new SessionDO(state, { ...env, MAIN_MCP: {
      async synchronizeManagedMemorySnapshots() {
        reconciliations++;
        canonical = projection;
        return { type: "synchronized", conflicts: [], recoveredWipes: [] };
      },
    } } as never);
    instance.setState({ ...instance.state, tenant_id: "default", session_id: "memory-session" });
    instance.currentWarmupGen = "runtime-generation";
    instance.hasWritableManagedMemoryMount = true;
    instance.portsSandbox = {
      async syncStorage(reason: string) {
        // Existing copy-sync checkpoint writes Memory only; turn_end also publishes outputs.
        if (reason !== "checkpoint") publications++;
        if (fail) throw new Error("Memory write-back failed");
        projection = "MEMORY_OK";
      },
    };
    const fence = { sessionId: "memory-session", executionId: "execution", generation: 1 };
    if (fail) {
      await expect(instance.synchronizeManagedMemoryStores(fence)).rejects.toThrow("Memory write-back failed");
      expect(reconciliations).toBe(0);
      expect(canonical).toBe("");
    } else {
      await instance.synchronizeManagedMemoryStores(fence);
      expect(canonical).toBe("MEMORY_OK");
      expect(reconciliations).toBe(1);
    }
    expect(publications).toBe(0);
  });
});
