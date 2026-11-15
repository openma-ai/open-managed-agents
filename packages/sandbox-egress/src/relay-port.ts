/** Sandbox-local forwarder address. Stable across relay restarts so long-lived
 * processes keep using their inherited proxy environment. Occupancy is an error,
 * never a reason to select another port. Shared by every proxy-env installer. */
export const SANDBOX_RELAY_PORT = 18080;
