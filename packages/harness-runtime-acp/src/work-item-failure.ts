export type NodeManagedAcpWorkItemPhase = "startup" | "run" | "finalization";

/** Explicit phase evidence for asynchronous failures; never infer startup
 * exhaustion from a rejected completion after a run has already started. */
export class NodeManagedAcpWorkItemFailure extends Error {
  constructor(readonly phase: NodeManagedAcpWorkItemPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "NodeManagedAcpWorkItemFailure";
  }
}

/** Construct only at a proven pre-native preparation boundary. Codes are a
 * closed wire vocabulary, not provider messages. cause stays local. */
export class NodeManagedAcpStartupConfigurationFailure extends NodeManagedAcpWorkItemFailure {
  constructor(readonly reason: "model_unavailable" | "anthropic_protocol_required" | "preparation_failed", cause: unknown) {
    const messages = {
      model_unavailable: "ACP startup requires an active workspace model card",
      anthropic_protocol_required: "ACP harness requires [anthropic-messages] on the configured model card",
      preparation_failed: "ACP session preparation failed",
    };
    super("startup", new Error(messages[reason], {cause}));
    this.name = "NodeManagedAcpStartupConfigurationFailure";
  }
}
