import type {
  CredentialValidationProbe,
  CredentialValidationProbePort,
  ProbeCredentialValidation,
} from "@open-managed-agents/managed-agents-application";

export class IndeterminateCredentialValidationProbe
  implements CredentialValidationProbePort
{
  async validate(
    input: ProbeCredentialValidation,
  ): Promise<CredentialValidationProbe> {
    const auth = input.credential.auth;
    return {
      hasRefreshToken:
        auth.type === "mcp_oauth" &&
        auth.refresh !== undefined &&
        auth.refresh !== null &&
        auth.refresh.refreshToken !== null,
      mcpProbe: null,
      refresh: null,
      status: "indeterminate",
    };
  }
}
