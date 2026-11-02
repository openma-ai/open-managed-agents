// The default auth component: better-auth behind the control plane's NodeAuth
// contract (see @open-managed-agents/control-plane-node). A deployment can
// pass any object with that shape instead.

import { applyBetterAuthSchema } from "@open-managed-agents/schema";
import {
  buildBetterAuth,
  validateOidcSignInProviders,
  type OidcSignInProvider,
} from "@open-managed-agents/auth-config";
import { ensureTenantSqlite } from "@open-managed-agents/control-plane-node";
import type { EmailSender } from "@open-managed-agents/email";
import type {
  NodeAuth,
  NodeConfig,
  NodeDatabase,
} from "@open-managed-agents/control-plane-node";

export type {
  NodeAuth,
  NodeAuthSession,
  NodeSignInMethods,
} from "@open-managed-agents/control-plane-node";

export interface BetterAuthComponentOptions {
  config: Pick<NodeConfig, "auth" | "http">;
  database: NodeDatabase;
  email: EmailSender | null;
  /** Invoked when BETTER_AUTH_SECRET is unset; the default generates a per-process secret. */
  onMissingSecret?: () => void;
  /**
   * Deployment wire point for sign-in. `oidc` adds OpenID Connect providers,
   * such as a company SSO; `emailPassword: false` leaves only OAuth and OIDC
   * sign-in. Built-in Google and GitHub still follow the config.
   */
  signIn?: {
    oidc?: readonly OidcSignInProvider[];
    emailPassword?: boolean;
  };
}

export async function createBetterAuthComponent(
  options: BetterAuthComponentOptions,
): Promise<NodeAuth> {
  const { config, database, email } = options;
  const { sql } = database;
  const oidcProviders = options.signIn?.oidc ?? [];
  const emailPassword = options.signIn?.emailPassword ?? true;
  validateOidcSignInProviders(oidcProviders);
  const secret = config.auth.secret ?? randomSecret(options.onMissingSecret);
  const shared = {
    sender: email,
    secret,
    baseURL: config.http.publicBaseUrl,
    googleClientId: config.auth.google.clientId,
    googleClientSecret: config.auth.google.clientSecret,
    githubClientId: config.auth.github.clientId,
    githubClientSecret: config.auth.github.clientSecret,
    requireEmailVerify: config.auth.requireEmailVerify,
    cookieDomain: config.auth.cookieDomain,
    oidcProviders,
    emailPassword,
    ensureTenant: (u: { id: string; name?: string | null; email?: string | null }) =>
      ensureTenantSqlite(sql, u.id, u.name, u.email),
  };

  if (!database.openAuthDatabase) {
    throw new Error(
      "The default Better Auth adapter needs NodeDatabase.openAuthDatabase(); "
        + "pass your own NodeAuth (or auth: null) when supplying a database without it.",
    );
  }
  const authDatabase = await database.openAuthDatabase({ sqlitePath: config.auth.databasePath });
  await applyBetterAuthSchema({ sql: authDatabase.sql, dialect: database.dialect });
  const auth = buildBetterAuth({ ...shared, database: authDatabase.database });
  const stop = authDatabase.stop;

  return {
    description: `better-auth-${database.dialect === "postgres" ? "pg" : database.dialect}`,
    signInMethods: {
      emailPassword,
      oidc: oidcProviders.map((p) => ({ id: p.id, name: p.name })),
    },
    handler: (request) => auth.handler(request),
    resolveSession: async (headers) => {
      const session = (await auth.api.getSession({ headers })) as
        | { user?: { id: string; email?: string | null; name?: string | null } }
        | null;
      if (!session?.user) return null;
      return {
        userId: session.user.id,
        email: session.user.email ?? null,
        name: session.user.name ?? null,
      };
    },
    findUser: async (userId) => {
      const user = await (await auth.$context).internalAdapter.findUserById(userId);
      return user ? { name: user.name ?? null, email: user.email ?? null } : null;
    },
    ...(stop !== undefined && { stop }),
  };
}

function randomSecret(onMissing: (() => void) | undefined): string {
  onMissing?.();
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
