// Auth component contract. The control plane needs three things from an
// identity provider: a handler for /auth/*, session resolution from request
// headers, and a user lookup for membership listings. A deployment passes any
// object with this shape (the OMA distribution's default is better-auth), or
// null to run every request as the "default" tenant.

import type { SignInProviderInfo } from "@open-managed-agents/shared";

export interface NodeAuthSession {
  userId: string;
  email: string | null;
  name: string | null;
}

/** Sign-in methods an auth component offers; /auth-info reports them. */
export interface NodeSignInMethods {
  /** Email and password sign-in and sign-up. */
  emailPassword: boolean;
  /** Deployment-configured OpenID Connect providers. */
  oidc: SignInProviderInfo[];
}

export interface NodeAuth {
  /** Shown in /health as `auth`. */
  description: string;
  /** When present, /auth-info reports these instead of the config defaults. */
  signInMethods?: NodeSignInMethods;
  /** Serves everything under /auth/*. */
  handler(request: Request): Promise<Response> | Response;
  /** The signed-in user for a request, or null. */
  resolveSession(headers: Headers): Promise<NodeAuthSession | null>;
  /** Display fields for a user id (tenant membership listings). */
  findUser(userId: string): Promise<{ name: string | null; email: string | null } | null>;
  stop?(): Promise<void>;
}
