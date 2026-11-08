// Cloudflare RunnerRelayPort: attach a harness to the RuntimeRoom Durable
// Object of a registered runner. The DO class lives in the main worker; the
// agent worker binds the same namespace through the cross-script binding
// (wrangler.jsonc `script_name`), so no service hop through main is needed.
import type { RunnerRelayAttachResult, RunnerRelayPort, RunnerRelaySocket } from "@open-managed-agents/agent-harness";

export const RUNTIME_ROOM_BINDING_MISSING =
  "RUNTIME_ROOM binding missing on agent worker — check wrangler.jsonc cross-script DO binding";

/**
 * Headers keyed off by RuntimeRoom's fetch handler: `x-attach-role` and
 * `x-session-id` route the socket; `x-harness-tenant` lets RuntimeRoom stamp
 * `tenant_id` on session-scoped frames (omitted when unknown); and
 * `x-runtime-replay` resumes one turn's output after the given sequences.
 */
export function createRuntimeRoomRelay(
  namespace: DurableObjectNamespace | undefined,
): RunnerRelayPort {
  return {
    async attachHarness(input): Promise<RunnerRelayAttachResult> {
      if (!namespace) return { type: "unavailable", message: RUNTIME_ROOM_BINDING_MISSING };
      const stub = namespace.get(namespace.idFromName(input.runtimeId));
      const headers: Record<string, string> = {
        Upgrade: "websocket",
        "x-attach-role": "harness",
        "x-session-id": input.sessionId,
      };
      if (input.tenantId) headers["x-harness-tenant"] = input.tenantId;
      if (input.replay) headers["x-runtime-replay"] = JSON.stringify(input.replay);
      const response = await stub.fetch(
        new Request("http://runtime-room/_attach_harness", { headers }),
      );
      if (response.status !== 101 || !response.webSocket) {
        return { type: "refused", status: response.status };
      }
      return { type: "attached", socket: response.webSocket as unknown as RunnerRelaySocket };
    },
  };
}
