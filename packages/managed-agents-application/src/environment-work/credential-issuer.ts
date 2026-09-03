import type { Environment } from "../domain/environment";
import type { EnvironmentWorkSecret } from "@open-managed-agents/domain/environment-work";
import type { Session } from "../domain/session";

export interface IssueEnvironmentWorkSessionCredential {
  workspaceId: string;
  workId: string;
  environment: Environment;
  session: Session;
}

export type IssueEnvironmentWorkSessionCredentialResult =
  | { type: "issued"; secret: EnvironmentWorkSecret }
  | { type: "rejected"; message: string };

export interface EnvironmentWorkSessionCredentialIssuerPort {
  issue(
    input: IssueEnvironmentWorkSessionCredential,
  ): Promise<IssueEnvironmentWorkSessionCredentialResult>;
}
