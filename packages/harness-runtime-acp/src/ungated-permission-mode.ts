import type { AcpSession } from "@openma/common/acp-runtime";
import type { WorkControlRuntime } from "./work-control-runtime.js";

/** Pinned harnesses that have NO native permission gate: every tool call runs
 * without ACP `session/request_permission`, and no `mode` config option exists.
 * That behavior is exactly `always_allow` and can prove nothing stricter.
 * The identity is the self-reported ACP agentInfo of the installed, pinned
 * package, never a Work/agent-supplied claim. */
const UNGATED_PROFILES = [
  // @openma/pi-acp: pi has no tool permission system; requestPermission is
  // used only for extension UI choices, never to gate tool execution.
  { id: "pi-acp", name: "openma-pi-acp", versions: ["0.1.8"] },
] as const;

type Apply = WorkControlRuntime["applyPermissionMode"];

/** Wrap the certified common setter. Ungated profiles accept only
 * `always_allow` (inherent; nothing to set or drift-check) and refuse stricter
 * modes before dispatch. Every other harness keeps the common verification. */
export function withUngatedPermissionProfiles(apply: Apply): Apply {
  return async (session: AcpSession, options) => {
    const info = (session as { agentInfo?: { name?: unknown; version?: unknown } }).agentInfo;
    const profile = UNGATED_PROFILES.find(candidate => candidate.id === options.harnessId
      && candidate.name === info?.name && (candidate.versions as readonly unknown[]).includes(info?.version));
    if (!profile) return apply(session, options);
    options.abortSignal.throwIfAborted();
    if (session.configOptions.some(option => option.id === "mode")) {
      throw new Error(`Ungated harness ${profile.id} unexpectedly advertises a native permission mode`);
    }
    if (options.mode !== "always_allow") {
      throw new Error(`Harness ${profile.id} has no native permission gate; permission policy ${options.mode} cannot be enforced`);
    }
    return { status: "inherent", verification: "ungated-harness-profile" };
  };
}
