// Runtime pairing tokens — the headless counterpart of `oma bridge setup`'s
// browser loopback flow.
//
// The browser flow mints a one-time `code` bound to a CLI-chosen `state`
// (POST /v1/oma/runtimes/connect-runtime) and the CLI swaps both at
// POST /agents/runtime/exchange. A pairing token is the same (code, state)
// pair minted by the server and handed to the user as one copy-pasteable
// string, so a machine without a browser (SSH box, CI VM, container) can run
// `oma bridge setup --token <token>` against the unchanged exchange route.
//
// Shape: `omrp_<code>_<state>` where both parts are lowercase hex.

export const RUNTIME_PAIRING_TOKEN_PREFIX = "omrp_";

export interface RuntimePairingTokenParts {
  code: string;
  state: string;
}

/** Response of POST /v1/oma/runtimes/pairing-tokens. */
export interface RuntimePairingTokenResponse {
  pairing_token: string;
  /** Unix seconds. Single-use; unused tokens simply expire. */
  expires_at: number;
  /** Ready-to-paste command for the target machine. */
  install_command: string;
}

const PART = /^[0-9a-f]{16,128}$/;

export function formatRuntimePairingToken(parts: RuntimePairingTokenParts): string {
  if (!PART.test(parts.code) || !PART.test(parts.state)) {
    throw new Error("pairing token parts must be lowercase hex");
  }
  return `${RUNTIME_PAIRING_TOKEN_PREFIX}${parts.code}_${parts.state}`;
}

/** Returns null for anything that is not a well-formed pairing token. */
export function parseRuntimePairingToken(token: string): RuntimePairingTokenParts | null {
  const trimmed = token.trim();
  if (!trimmed.startsWith(RUNTIME_PAIRING_TOKEN_PREFIX)) return null;
  const [code, state, ...rest] = trimmed.slice(RUNTIME_PAIRING_TOKEN_PREFIX.length).split("_");
  if (rest.length > 0 || code === undefined || state === undefined) return null;
  if (!PART.test(code) || !PART.test(state)) return null;
  return { code, state };
}
