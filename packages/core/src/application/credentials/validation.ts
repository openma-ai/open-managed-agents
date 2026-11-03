import type { Credential } from "../domain/credential.js";

export interface ProbeCredentialValidation {
  workspaceId: string;
  credential: Credential;
}

export interface CredentialResponseObservation {
  body: string;
  bodyTruncated: boolean;
  contentType: string;
  statusCode: number;
}

export interface CredentialMcpProbe {
  response: CredentialResponseObservation | null;
  method: string;
}

export interface CredentialRefreshProbe {
  response: CredentialResponseObservation | null;
  status: "succeeded" | "failed" | "connect_error" | "no_refresh_token";
}

/**
 * Tokens issued by a successful refresh. This stays inside the application
 * process so the rotated refresh token can be saved. It is not part of the
 * public validation view and must not be copied into logs or error text.
 */
export interface CredentialValidationRotation {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export interface CredentialValidationProbe {
  hasRefreshToken: boolean;
  mcpProbe: CredentialMcpProbe | null;
  refresh: CredentialRefreshProbe | null;
  status: "valid" | "invalid" | "indeterminate";
  /**
   * Present only after the token endpoint issues a new access token.
   * The runtime probe stores this as a non-enumerable property.
   */
  rotation?: CredentialValidationRotation | null;
}

export interface CredentialValidationProbePort {
  validate(input: ProbeCredentialValidation): Promise<CredentialValidationProbe>;
}
