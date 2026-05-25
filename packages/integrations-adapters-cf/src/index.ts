// @open-managed-agents/integrations-adapters-cf
//
// Cloudflare-specific adapters that implement integrations-core ports against
// D1, KV, service bindings, Web Crypto, and the Workers fetch API.
//
// Consumed by apps/integrations' composition root. Provider packages never
// depend on this — they receive port instances as constructor arguments.

export { WebCryptoAesGcm } from "./crypto";
export { WebCryptoHmacVerifier } from "./hmac";
export { WebCryptoJwtSigner } from "./jwt";
export { WorkerHttpClient } from "./http";
export type { WorkerHttpClientOptions } from "./http";
export { SystemClock } from "./clock";
export { CryptoIdGenerator } from "./ids";
export { SqlLinearInstallationRepo } from "./d1/installation-repo";
export { SqlLinearPublicationRepo } from "./d1/publication-repo";
export { SqlLinearAppRepo } from "./d1/app-repo";
export { SqlGitHubAppRepo } from "./d1/github-app-repo";
// GitHub adapters — parallel to Linear's, separate github_* tables.
export { SqlGitHubInstallationRepo } from "./d1/github/installation-repo";
export { SqlGitHubPublicationRepo } from "./d1/github/publication-repo";
export { SqlGitHubWebhookEventStore } from "./d1/github/webhook-event-store";
export { SqlLinearEventStore } from "./d1/linear-event-store";
export { SqlLinearIssueSessionRepo } from "./d1/linear/issue-session-repo";
export { SqlGitHubIssueSessionRepo } from "./d1/github/issue-session-repo";
export { SqlLinearSetupLinkRepo } from "./d1/setup-link-repo";
export { SqlLinearDispatchRuleRepo } from "./d1/dispatch-rule-repo";
export { D1TenantResolver } from "./d1/tenant-resolver";
// Slack adapters — parallel to Linear's, separate slack_* tables.
export { SqlSlackAppRepo } from "./d1/slack/app-repo";
export { SqlSlackInstallationRepo } from "./d1/slack/installation-repo";
export { SqlSlackPublicationRepo } from "./d1/slack/publication-repo";
export { SqlSlackWebhookEventStore } from "./d1/slack/webhook-event-store";
export { SqlSlackSessionScopeRepo } from "./d1/slack/session-scope-repo";
export { SqlSlackSetupLinkRepo } from "./d1/slack/setup-link-repo";
export { ServiceBindingSessionCreator } from "./service-binding-session-creator";
export type { ServiceBindingSessionCreatorOptions } from "./service-binding-session-creator";
export { ServiceBindingVaultManager } from "./service-binding-vault-manager";
export type { ServiceBindingVaultManagerOptions } from "./service-binding-vault-manager";
export { buildCfRepos, buildCfContainer } from "./cf-container";
export type { CfReposEnv, CfContainerEnv } from "./cf-container";
