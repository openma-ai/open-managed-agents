// The permission scope of one issued sandbox token (#561). Exactly two
// values, chosen at issue time from where the harness really runs, stored
// beside the token's hash on the execution attempt row (never in the token
// string), and checked in the same read as the hash and the lease:
//   all    — the harness runs inside the sandbox: model gateway, MCP gateway,
//            sandbox API and Vault egress;
//   egress — the harness runs outside; the sandbox only needs the egress relay.
// Re-signing an attempt keeps its scope (the store refuses a different one).
// A missing or unknown scope on a stored entry is a definite rejection: there
// is no default that widens.

export type SandboxTokenScope = "all" | "egress";

/** Where a token is presented. `api`: model gateway, MCP gateway, sandbox API. */
export type SandboxTokenChannel = "api" | "egress";

/** Where the harness of an execution runs, decided by the issuing host. */
export type SandboxHarnessPlacement = "in_sandbox" | "outside_sandbox";

export const isSandboxTokenScope = (value: unknown): value is SandboxTokenScope => value === "all" || value === "egress";

/** The one placement rule, for every issuing host: the agent's harness name.
 * `acp-sandbox` runs the ACP agent inside the sandbox (it calls the model
 * gateway, the MCP gateway and the sandbox API from there); every other
 * harness runs in the control plane and the sandbox only executes tools. */
export function sandboxHarnessPlacement(harness: string | null | undefined): SandboxHarnessPlacement {
  return harness === "acp-sandbox" ? "in_sandbox" : "outside_sandbox";
}

export function sandboxTokenScopeFor(placement: SandboxHarnessPlacement): SandboxTokenScope {
  if (placement === "in_sandbox") return "all";
  if (placement === "outside_sandbox") return "egress";
  throw new Error(`Unknown sandbox harness placement: ${String(placement)}`);
}

/** What each channel requires: `api` needs `all`; `egress` takes either. */
export function sandboxTokenScopeAdmits(scope: unknown, channel: SandboxTokenChannel): boolean {
  if (!isSandboxTokenScope(scope)) return false;
  return scope === "all" || channel === "egress";
}
