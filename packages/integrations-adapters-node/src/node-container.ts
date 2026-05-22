// Composition root for the Node runtime.
//
// Mirrors integrations-adapters-cf/cf-container.ts but uses SqlClient
// (sqlite/PG via the existing dispatch) instead of D1Database, and resolves
// tenant via the membership table the auth bootstrap maintains.
//
// Two factories:
//   - buildNodeRepos(env)    : repos + crypto/hmac/jwt/http/clock/ids only.
//                              No SessionCreator/VaultManager. Used by the
//                              read-only integrations endpoints in main-node.
//   - buildNodeContainer(env): full Container including SessionCreator and
//                              VaultManager — wired against in-process
//                              session/vault services rather than a
//                              service-binding stub.
//
// SessionCreator/VaultManager on Node are constructor-injected because
// the in-process services live on apps/main-node. We accept them as
// dependencies rather than building HTTP shims to mirror the CF
// service-binding indirection.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type {
  Container,
  SessionCreator,
  VaultManager,
} from "@open-managed-agents/integrations-core";
import { SystemClock } from "./clock";
import { WebCryptoAesGcm } from "./crypto";
import { WebCryptoHmacVerifier } from "./hmac";
import { WorkerHttpClient } from "./http";
import { CryptoIdGenerator } from "./ids";
import { WebCryptoJwtSigner } from "./jwt";
import {
  SqlGitHubAppRepo,
  SqlGitHubInstallationRepo,
  SqlGitHubIssueSessionRepo,
  SqlGitHubPublicationRepo,
  SqlGitHubWebhookEventStore,
  SqlLinearAppRepo,
  SqlLinearDispatchRuleRepo,
  SqlLinearEventStore,
  SqlLinearInstallationRepo,
  SqlLinearIssueSessionRepo,
  SqlLinearPublicationRepo,
  SqlLinearSetupLinkRepo,
  SqlSlackSessionScopeRepo,
} from "@open-managed-agents/integrations-adapters-cf";
import { SqlMembershipTenantResolver } from "./sql/membership-tenant-resolver";

export interface NodeReposEnv {
  /** Single SqlClient that holds the integration tables (linear_, github_,
   *  and slack_ prefixes) along with the membership table the tenant
   *  resolver reads. Self-host runs one database; we don't split
   *  integrations data into a separate connection. */
  sql: SqlClient;
  /** Drizzle wrapper for the same database — the dialect-blind port that
   *  ported adapters consume. As more adapters move from raw SqlClient
   *  to Drizzle this widens; until then both surfaces coexist. */
  db: OmaDb;
  PLATFORM_ROOT_SECRET: string;
}

export interface NodeContainerEnv extends NodeReposEnv {
  sessions: SessionCreator;
  vaults: VaultManager;
}

export function buildNodeRepos(env: NodeReposEnv) {
  const sql = env.sql;
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const cryptoImpl = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "integrations.tokens");
  const hmac = new WebCryptoHmacVerifier();
  const jwt = new WebCryptoJwtSigner(env.PLATFORM_ROOT_SECRET);
  const http = new WorkerHttpClient();
  const tenants = new SqlMembershipTenantResolver(sql);
  const linearInstallations = new SqlLinearInstallationRepo(env.db, cryptoImpl, ids);
  // SqlLinearPublicationRepo needs Crypto: the publication-first install flow
  // stores OAuth client_secret + webhook_secret encrypted on the row.
  const linearPublications = new SqlLinearPublicationRepo(env.db, ids, cryptoImpl);
  const githubInstallations = new SqlGitHubInstallationRepo(env.db, cryptoImpl, ids);
  const githubPublications = new SqlGitHubPublicationRepo(env.db, ids, cryptoImpl);
  const apps = new SqlLinearAppRepo(env.db, cryptoImpl, ids);
  const githubApps = new SqlGitHubAppRepo(env.db, cryptoImpl, ids);
  const linearEvents = new SqlLinearEventStore(env.db);
  const githubWebhookEvents = new SqlGitHubWebhookEventStore(env.db);
  const linearIssueSessions = new SqlLinearIssueSessionRepo(env.db);
  const githubIssueSessions = new SqlGitHubIssueSessionRepo(env.db);
  const setupLinks = new SqlLinearSetupLinkRepo(env.db, ids);
  const dispatchRules = new SqlLinearDispatchRuleRepo(env.db, ids);
  const sessionScopes = new SqlSlackSessionScopeRepo(env.db);

  return {
    clock,
    ids,
    crypto: cryptoImpl,
    hmac,
    jwt,
    http,
    tenants,
    linearInstallations,
    linearPublications,
    githubInstallations,
    githubPublications,
    apps,
    githubApps,
    linearEvents,
    githubWebhookEvents,
    linearIssueSessions,
    githubIssueSessions,
    sessionScopes,
    setupLinks,
    dispatchRules,
  };
}

export function buildNodeContainer(
  env: NodeContainerEnv,
): Container & ReturnType<typeof buildNodeRepos> {
  const repos = buildNodeRepos(env);
  return {
    ...repos,
    installations: repos.linearInstallations,
    publications: repos.linearPublications,
    webhookEvents: repos.linearEvents,
    sessions: env.sessions,
    vaults: env.vaults,
  };
}
