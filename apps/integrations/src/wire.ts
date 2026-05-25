// Composition root.
//
// Each provider gets its own Container so installations/publications/
// webhookEvents point at the right per-provider table. Linear → linear_*,
// GitHub → github_*, Slack → slack_*. The shared adapters
// (clock/ids/crypto/hmac/jwt/http/sessions/vaults/tenants/githubApps/
// issueSessions/etc.) come from buildCfContainer regardless of provider —
// only the provider-scoped repos differ.
//
// To add a provider that fits the linear schema verbatim: just instantiate it
// with buildContainer(env). For one with parallel tables (slack/github-style),
// follow buildGitHubContainer / buildSlackContainer below.
//
// DB routing:
//   - integrationsDb : env.INTEGRATIONS_DB. Holds linear_*/github_*/slack_*.
//   - controlPlaneDb : env.MAIN_DB. TenantResolver looks up user.tenantId here.
// Tenant sharding (per-tenant DB) doesn't apply to integration tables — the
// webhook entry can't resolve tenant before signature verify.

import {
  buildCfContainer,
  SqlGitHubWebhookEventStore,
  SqlSlackAppRepo,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackSessionScopeRepo,
  SqlSlackSetupLinkRepo,
  SqlSlackWebhookEventStore,
  type CfContainerEnv,
} from "@open-managed-agents/integrations-adapters-cf";
import { drizzle } from "drizzle-orm/d1";
import type { GitHubContainer } from "@open-managed-agents/github";
import type { LinearContainer } from "@open-managed-agents/linear";
import type { SlackContainer } from "@open-managed-agents/slack";
import type { Env } from "./env";

function cfEnvOf(env: Env): CfContainerEnv {
  return {
    integrationsDb: env.INTEGRATIONS_DB,
    controlPlaneDb: env.MAIN_DB,
    PLATFORM_ROOT_SECRET: env.PLATFORM_ROOT_SECRET,
    MAIN: env.MAIN,
    INTEGRATIONS_INTERNAL_SECRET: env.INTEGRATIONS_INTERNAL_SECRET,
  };
}

/**
 * Linear container — `installations`/`publications`/`webhookEvents`
 * already point at the linear_* repos via buildCfContainer's default
 * wiring. The Linear publication repo (`linearPublications`) implements
 * `LinearPublicationRepo` directly (publication-first install fields live
 * on the row), so we re-narrow the spread back to the concrete type.
 * `webhookEvents` similarly narrows to `LinearEventStore` for the merged
 * `linear_events` drain queue. sessionScopes is Linear-irrelevant but
 * required by the Container shape; we hand it the Slack impl since the
 * slot is unused on the Linear path (Linear uses issueSessions instead).
 */
export function buildContainer(env: Env): LinearContainer {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    publications: base.linearPublications,
    // Narrow the webhookEvents slot from WebhookEventStore (Container shape)
    // to LinearEventStore (LinearContainer shape). The runtime instance is
    // already the narrower type — base.linearEvents — but the spread above
    // erases it back to the wider Container shape, so re-assign explicitly.
    webhookEvents: base.linearEvents,
    sessionScopes: new SqlSlackSessionScopeRepo(drizzle(env.INTEGRATIONS_DB)),
  };
}

/**
 * GitHub container — swaps in the github_* installations/publications repos
 * AND the github_webhook_events store (no longer borrows linear_*).
 * All other shared adapters (githubApps, sessions, vaults, etc.) carry over
 * unchanged. sessionScopes follows the same unused-but-required pattern
 * as buildContainer.
 *
 * `publications` is narrowed to GitHubPublicationRepo so the provider can
 * call into the publication-first credential staging methods
 * (insertShell, setCredentials, getPrivateKey, bindInstallation,
 * findByAppOmaId).
 */
export function buildGitHubContainer(env: Env): GitHubContainer {
  const base = buildCfContainer(cfEnvOf(env));
  return {
    ...base,
    installations: base.githubInstallations,
    publications: base.githubPublications,
    webhookEvents: new SqlGitHubWebhookEventStore(drizzle(env.INTEGRATIONS_DB)),
    sessionScopes: new SqlSlackSessionScopeRepo(drizzle(env.INTEGRATIONS_DB)),
  };
}

/**
 * Slack container — parallel `slack_*` tables, with the Slack-specific
 * SlackInstallationRepo (adds getUserToken/setUserToken/setBotVaultId/getBotVaultId).
 *
 * Reuses every shared adapter (clock/ids/crypto/hmac/jwt/http/sessions/vaults/
 * tenants/githubApps/issueSessions) from buildCfContainer
 * and only swaps the installations/publications/apps/setupLinks/webhookEvents/
 * sessionScopes ports for slack-specific D1 repos.
 */
export function buildSlackContainer(env: Env): SlackContainer {
  const base = buildCfContainer(cfEnvOf(env));
  const idb = drizzle(env.INTEGRATIONS_DB);
  return {
    ...base,
    installations: new SqlSlackInstallationRepo(idb, base.crypto, base.ids),
    publications: new SqlSlackPublicationRepo(idb, base.ids, base.crypto),
    apps: new SqlSlackAppRepo(idb, base.crypto, base.ids),
    webhookEvents: new SqlSlackWebhookEventStore(idb),
    sessionScopes: new SqlSlackSessionScopeRepo(idb),
    setupLinks: new SqlSlackSetupLinkRepo(idb, base.ids),
  };
}
