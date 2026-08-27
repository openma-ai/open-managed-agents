import type { Credential } from "../domain/credential";

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

export interface CredentialValidationProbe {
  hasRefreshToken: boolean;
  mcpProbe: CredentialMcpProbe | null;
  refresh: CredentialRefreshProbe | null;
  status: "valid" | "invalid" | "indeterminate";
}

export interface CredentialValidationProbePort {
  validate(input: ProbeCredentialValidation): Promise<CredentialValidationProbe>;
}
