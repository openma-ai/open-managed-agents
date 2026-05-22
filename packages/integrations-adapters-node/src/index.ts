// @open-managed-agents/integrations-adapters-node
//
// Node sibling of integrations-adapters-cf. Same port shapes; storage moves
// from D1Database to SqlClient, so the adapters work against better-sqlite3
// (single-instance) and pg-postgres (multi-replica) without further changes.
//
// Shared primitives (crypto/hmac/jwt/clock/ids/http) are duplicated rather
// than re-exported from -adapters-cf, because that package depends on
// @cloudflare/workers-types via its D1 imports — pulling it in here would
// drag CF types into Node consumers. The crypto/hmac/jwt code is just
// Web Crypto + global fetch, both available in Node 20+.

export { WebCryptoAesGcm } from "./crypto";
export { WebCryptoHmacVerifier } from "./hmac";
export { WebCryptoJwtSigner } from "./jwt";
export { WorkerHttpClient } from "./http";
export { SystemClock } from "./clock";
export { CryptoIdGenerator } from "./ids";

export { SqlMembershipTenantResolver } from "./sql/membership-tenant-resolver";

// GitHub adapter classes are dialect-blind (Drizzle on top of OmaDb), so the
// CF and Node packages share one canonical impl in -cf. Keep these as
// re-exports rather than mirrors so the two packages can't drift again.
export {
  SqlGitHubAppRepo,
  SqlGitHubInstallationRepo,
  SqlGitHubPublicationRepo,
  SqlGitHubWebhookEventStore,
  SqlGitHubIssueSessionRepo,
} from "@open-managed-agents/integrations-adapters-cf";

// Linear adapter classes are dialect-blind (Drizzle on top of OmaDb), so the
// CF and Node packages share one canonical impl in -cf. Keep these as
// re-exports rather than mirrors so the two packages can't drift again.
export {
  SqlLinearAppRepo,
  SqlLinearInstallationRepo,
  SqlLinearPublicationRepo,
  SqlLinearEventStore,
  SqlLinearIssueSessionRepo,
  SqlLinearSetupLinkRepo,
  SqlLinearDispatchRuleRepo,
} from "@open-managed-agents/integrations-adapters-cf";

// Slack adapter classes are dialect-blind (Drizzle on top of OmaDb), so the
// CF and Node packages share one canonical impl in -cf. Keep these as
// re-exports rather than mirrors so the two packages can't drift again.
export {
  SqlSlackAppRepo,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackWebhookEventStore,
  SqlSlackSessionScopeRepo,
  SqlSlackSetupLinkRepo,
} from "@open-managed-agents/integrations-adapters-cf";

export { buildNodeRepos, buildNodeContainer } from "./node-container";
export type { NodeReposEnv, NodeContainerEnv } from "./node-container";
