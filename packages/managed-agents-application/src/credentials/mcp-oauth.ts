/**
 * MCP OAuth protocol port (OpenMA extension). The adapter owns metadata
 * discovery (RFC 9728 / RFC 8414), client registration (RFC 7591) and
 * operator presets, the code exchange, and the post-connect probe; callers
 * only see their outcomes.
 */
export interface McpOAuthServerMetadata {
  /** RFC 8707 resource indicator of the MCP server. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

import type { McpOAuthFailureReason } from "../ports/mcp-oauth";

export type McpOAuthDiscoveryResult =
  | { type: "discovered"; metadata: McpOAuthServerMetadata; registrationEndpoint?: string }
  | { type: "failed"; reason: McpOAuthFailureReason };

export type McpOAuthClientResult =
  | { type: "client"; client: McpOAuthClient }
  | { type: "unavailable"; message: string };

export interface McpOAuthIssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export type McpOAuthExchangeResult =
  | { type: "issued"; tokens: McpOAuthIssuedTokens }
  | { type: "failed"; reason: McpOAuthFailureReason };

export interface McpOAuthPort {
  discover(mcpServerUrl: string): Promise<McpOAuthDiscoveryResult>;
  /** Dynamic registration, else an operator-configured client for the issuer. */
  client(input: {
    metadata: McpOAuthServerMetadata;
    registrationEndpoint?: string;
    callbackUri: string;
  }): Promise<McpOAuthClientResult>;
  exchangeCode(input: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    callbackUri: string;
    resource: string;
    client: McpOAuthClient;
  }): Promise<McpOAuthExchangeResult>;
  /** `tools/list` with the new token; descriptive only. `reason` is a code. */
  probe(mcpServerUrl: string, accessToken: string): Promise<{ ok: boolean; reason?: string }>;
}

/** Seals authorization state; ciphertexts must be authenticated (e.g. AES-GCM). */
export interface McpOAuthStateCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** PKCE verifier and S256 challenge. */
export interface McpOAuthPkce {
  create(): Promise<{ verifier: string; challenge: string }>;
}
