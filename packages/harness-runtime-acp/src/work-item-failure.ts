export type NodeManagedAcpWorkItemPhase = "startup" | "run" | "finalization";

/** Explicit phase evidence for asynchronous failures; never infer startup
 * exhaustion from a rejected completion after a run has already started. */
export class NodeManagedAcpWorkItemFailure extends Error {
  constructor(readonly phase: NodeManagedAcpWorkItemPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NodeManagedAcpWorkItemFailure";
  }
}
