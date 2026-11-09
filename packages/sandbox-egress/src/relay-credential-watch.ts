// When the forwarder stops itself. Its token is random (no expiry to read),
// so it asks the gateway: 401 = this token is definitely dead (execution
// ended, superseded, Session archived) → exit; 5xx / network error = could not
// check → stay up (a database blip must not kill every forwarder). A token
// swapped in while a probe was in flight is probed again before exiting, so a
// control plane installing a new token never loses to an exit decision.
import type { RelayBinding } from "./relay-binding.js";

export type RelayTokenStatus = "valid" | "invalid" | "unknown";

export interface RelayCredentialWatchPorts {
  read(): RelayBinding;
  probe(binding: RelayBinding): Promise<RelayTokenStatus>;
  exit(): void | Promise<void>;
}

/** One check; returns true when it decided to exit. */
export async function checkRelayCredential(ports: RelayCredentialWatchPorts): Promise<boolean> {
  let binding: RelayBinding;
  try { binding = ports.read(); } catch { await ports.exit(); return true; }
  for (let round = 0; round < 3; round++) {
    const status = await ports.probe(binding);
    if (status !== "invalid") return false;
    let current: RelayBinding;
    try { current = ports.read(); } catch { await ports.exit(); return true; }
    if (current.token === binding.token && current.sessionId === binding.sessionId) { await ports.exit(); return true; }
    binding = current;
  }
  return false;
}

/** The gateway's answer for this token: a resolve with an invalid target is
 * 400 once the token is accepted (no upstream contact), 401 when rejected. */
export async function probeRelayToken(binding: RelayBinding, send: (request: Request) => Promise<Response>, authorization: string): Promise<RelayTokenStatus> {
  try {
    const response = await send(new Request(new URL("/v1/oma/egress/resolve", binding.endpoint), {
      method: "POST", headers: { authorization, "x-oma-egress-target": "oma-relay-probe:" },
    }));
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return "invalid";
    return response.status < 500 ? "valid" : "unknown";
  } catch {
    return "unknown";
  }
}
