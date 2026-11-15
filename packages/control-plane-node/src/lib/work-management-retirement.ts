import type { SandboxManagedProcessHandle } from "@open-managed-agents/sandbox";

/** Exact-handle cleanup only; the caller still owns serialization and authority. */
export interface ManagementRetirementState {
  handle: SandboxManagedProcessHandle;
  current(): Promise<boolean>;
  /** Receipts belong to this exact handle, never to a Session or a new process. */
  retirementKillAcknowledged?: true;
  retirementTerminalStatus?: string;
}
export type RetirementCall = <T>(op: string, action: () => Promise<T>) => Promise<T>;
export async function retireManagementProcess(process: ManagementRetirementState, call: RetirementCall): Promise<void> {
  // Unknown authority throws: never interpret lookup failure as lost ownership.
  if (await call("current", () => process.current())) throw new Error("Previous management worker is still current");
  // Retain native success even when the caller has already stopped waiting.
  // Never record timeout/rejection as success or clear an unresolved RPC.
  if (!process.retirementKillAcknowledged) {
    await call("kill", async () => {
      await process.handle.kill("SIGTERM");
      process.retirementKillAcknowledged = true;
    });
  }
  if (process.retirementTerminalStatus !== undefined) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await call("status", async () => {
      const result = await process.handle.getStatus();
      if (["exited", "killed", "completed", "error"].includes(result)) process.retirementTerminalStatus = result;
      return result;
    });
    if (["exited", "killed", "completed", "error"].includes(status)) return;
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Previous management worker exit is unconfirmed");
}
