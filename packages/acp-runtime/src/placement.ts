import type { SandboxDuplexProcessPort } from "@open-managed-agents/sandbox";
import type {
  AcpRuntime,
  Spawner,
} from "@openma/common/acp-runtime";

import { AcpRuntimeImpl } from "./runtime.js";
import { SandboxSpawner } from "./spawners/sandbox.js";

/** Runtime placement is a composition decision, not a second ACP runtime.
 * Both branches construct the same AcpRuntimeImpl and therefore share ACP
 * negotiation, lifecycle, prompt streaming, cancellation, and restart logic. */
export type AcpRuntimePlacement =
  | {
      type: "local";
      /** Injected by a Node/desktop composition root so this cross-platform
       * module never imports node:child_process into a Worker bundle. */
      spawner: Spawner;
    }
  | {
      type: "sandbox";
      sandbox: SandboxDuplexProcessPort;
    };

export function createAcpRuntime(
  placement: AcpRuntimePlacement,
): AcpRuntime {
  const spawner = placement.type === "local"
    ? placement.spawner
    : new SandboxSpawner(placement.sandbox);
  return new AcpRuntimeImpl(spawner);
}
