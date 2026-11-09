import { installAcpSandboxAgent, type AcpSandboxAgentPreparation } from "@open-managed-agents/acp-runtime/sandbox-agent";
import { asWireEvents } from "@open-managed-agents/session-runtime-contract/requires-action";
import { generateEventId } from "@open-managed-agents/shared";
import type { HarnessRuntime } from "./interface";
import { isDispatchedUnknown, requestUnknownToolRetry } from "./unknown-tool-retry";

/** Installation is a host operation, not a model call. Record its actual exec
 * before dispatch so the existing recovery/confirmation machinery owns any
 * uncertain attempt, including a crash before the installer catch runs. */
export async function installAcpAgentWithHistory(runtime: HarnessRuntime, preparation: AcpSandboxAgentPreparation): Promise<AcpSandboxAgentPreparation> {
  if (!preparation.install) return preparation;
  const registry = preparation.install.id + "@" + preparation.install.version;
  return installAcpSandboxAgent({ exec: async (command, timeout) => {
    const events = asWireEvents(runtime.history.getEvents()).filter(event =>
      (event.session_thread_id ?? "sthr_primary") === (runtime.sessionThreadId ?? "sthr_primary"));
    const original = [...events].reverse().find(event => {
      const input = event.input as Record<string, unknown> | undefined;
      return event.type === "agent.tool_use" && event.name === "acp_install"
        && typeof event.id === "string" && !event.id.startsWith("retry:")
        && input?.registry === registry && input.command === command && input.timeout === timeout;
    });
    const details = (event: Record<string, unknown>) => event.details as Record<string, unknown> | undefined;
    if (typeof original?.id === "string" && events.some(event => event.type === "session.warning" && event.source === "tool_outcome_unknown" && details(event)?.tool_use_id === original.id)) {
      let id: string = original.id;
      // Follow the existing linked retry calls; no second execution or ledger.
      for (;;) {
        const warning = events.find(event => event.type === "session.warning" && event.source === "tool_outcome_unknown" && details(event)?.tool_use_id === id);
        const next = warning ? details(warning)?.retry_request_id : undefined;
        if (typeof next !== "string") break;
        id = next;
      }
      const result = events.find(event => event.type === "agent.tool_result" && event.tool_use_id === id);
      if (!result || result.type !== "agent.tool_result" || result.is_error) throw new Error("ACP install retry did not complete successfully; automatic reinstall is blocked");
      if (typeof result.content === "string") return result.content;
      if (!Array.isArray(result.content)) throw new Error("ACP install retry has no text result");
      return result.content.flatMap((block: { type?: string; text?: unknown }) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    }
    const id = generateEventId();
    runtime.broadcast({ type: "agent.tool_use", id, name: "acp_install", input: { registry, command, timeout: timeout! },
      ...(runtime.sessionThreadId ? { session_thread_id: runtime.sessionThreadId } : {}) });
    try {
      const output = await runtime.sandbox.exec(command, timeout);
      runtime.broadcast({ type: "agent.tool_result", tool_use_id: id, content: output });
      return output;
    } catch (error) {
      if (isDispatchedUnknown(error)) requestUnknownToolRetry(runtime, id);
      runtime.broadcast({ type: "agent.tool_result", tool_use_id: id, is_error: true,
        content: isDispatchedUnknown(error) ? "Installation outcome unknown; explicit authorization is required for another attempt." : String(error) });
      throw error;
    }
  } }, preparation);
}
