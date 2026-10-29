/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for `cap_cli` credentials
 * (OpenMA extension). The adapter owns the per-CLI endpoints and the HTTP
 * exchange; callers only see the flow state and its outcome.
 */
export interface CapCliDeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  /** Unix ms after which the device code is no longer valid. */
  expiresAtMs: number;
}

export interface CapCliIssuedToken {
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
  extras: Record<string, string>;
}

export type CapCliDeviceFlowInitiateResult =
  | { type: "started"; state: CapCliDeviceFlowState }
  | { type: "unknown_cli" }
  | { type: "no_device_flow" }
  | { type: "upstream_error"; message: string };

export type CapCliDeviceFlowPollResult =
  | { type: "pending" }
  | { type: "slow_down"; intervalSeconds: number }
  | { type: "expired" }
  | { type: "denied" }
  | { type: "error"; oauthError: string; description?: string }
  | { type: "ready"; token: CapCliIssuedToken };

export interface CapCliDeviceFlowPort {
  initiate(cliId: string): Promise<CapCliDeviceFlowInitiateResult>;
  poll(cliId: string, state: CapCliDeviceFlowState): Promise<CapCliDeviceFlowPollResult>;
}

/** Seals flow tokens; ciphertexts must be authenticated (e.g. AES-GCM). */
export interface CapCliFlowTokenCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
