/**
 * Headless pairing for `oma bridge setup --token <omrp_…>`.
 *
 * A pairing token is the (code, state) pair the browser flow would have
 * delivered to the loopback callback, minted instead by
 * `oma runtime pair` / Console → Runtimes → "Connect machine". Setup
 * exchanges it at the unchanged /agents/runtime/exchange route.
 */

import {
  parseRuntimePairingToken,
  RUNTIME_PAIRING_TOKEN_PREFIX,
  type RuntimePairingTokenParts,
} from "@open-managed-agents/api-types";

export const PAIRING_TOKEN_ENV = "OMA_PAIRING_TOKEN";

/** `--token` wins over $OMA_PAIRING_TOKEN; blank values count as unset. */
export function pairingTokenFrom(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = flagValue ?? env[PAIRING_TOKEN_ENV];
  return value && value.trim() ? value.trim() : undefined;
}

export function decodePairingToken(token: string): RuntimePairingTokenParts {
  const parts = parseRuntimePairingToken(token);
  if (!parts) {
    throw new Error(
      `invalid pairing token — expected ${RUNTIME_PAIRING_TOKEN_PREFIX}…; ` +
        "mint a new one with `oma runtime pair` or Console → Runtimes → Connect machine",
    );
  }
  return parts;
}
