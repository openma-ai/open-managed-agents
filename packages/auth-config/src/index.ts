// Build a better-auth instance with the OMA-shared config.
//
// CF passes a drizzle-adapter wrapping MAIN_DB; Node passes either a
// better-sqlite3 db or a pg.Pool — kysely-adapter inside better-auth
// detects the dialect from the shape (`aggregate in db` → SqliteDialect,
// `connect in db` → PostgresDialect).
//
// Email-OTP / sendResetPassword / sendVerificationEmail mount only when
// the caller passes a non-null `sender` — preserves P0-followup default-off
// behavior. The tenant-create databaseHook lives here so the same
// "sign up auto-creates a workspace" flow runs on either runtime.

import { betterAuth } from "better-auth";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import type { EmailSender } from "@open-managed-agents/email";
import { buildSocialProviders } from "@open-managed-agents/shared";

/**
 * An OpenID Connect provider offered on the sign-in page, for example a
 * company SSO, Keycloak, or Okta. Users sign in with authorization code and
 * PKCE; the callback is `<baseURL>/auth/oauth2/callback/<id>`. The first
 * sign-in creates the user and a workspace, like any other sign-up.
 */
export interface OidcSignInProvider {
  /** Lowercase letters, digits, and dashes. Appears in the callback path. */
  id: string;
  /** Button label on the sign-in page, for example "Company SSO". */
  name: string;
  /** The provider's `/.well-known/openid-configuration` URL. */
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  /** Defaults to `openid profile email`. */
  scopes?: string[];
  /** Token endpoint client authentication. Defaults to `post`. */
  clientAuthentication?: "basic" | "post";
}

const RESERVED_PROVIDER_IDS = new Set(["email", "email-otp", "google", "github"]);

/** Throws on a provider list that cannot be served safely. */
export function validateOidcSignInProviders(providers: readonly OidcSignInProvider[]): void {
  const seen = new Set<string>();
  for (const p of providers) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.id) || RESERVED_PROVIDER_IDS.has(p.id)) {
      throw new Error(`OIDC provider id "${p.id}" must be lowercase letters, digits, and dashes, and not a built-in provider`);
    }
    if (seen.has(p.id)) throw new Error(`OIDC provider id "${p.id}" is configured twice`);
    seen.add(p.id);
    if (!p.name.trim()) throw new Error(`OIDC provider "${p.id}" needs a name`);
    if (!p.clientId || !p.clientSecret) {
      throw new Error(`OIDC provider "${p.id}" needs a client id and a client secret`);
    }
    let url: URL;
    try {
      url = new URL(p.discoveryUrl);
    } catch {
      throw new Error(`OIDC provider "${p.id}" has an invalid discovery URL`);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`OIDC provider "${p.id}" must use an https discovery URL`);
    }
  }
}

export interface BuildBetterAuthOpts {
  /** Driver handle. better-sqlite3 Database, pg.Pool, or a drizzle adapter
   *  (CF). better-auth's kysely-adapter detects the dialect; CF callers
   *  pass `drizzleAdapter(db, { provider: "sqlite", schema })` — that
   *  satisfies the same `database` slot. */
  database: unknown;
  /** Cookie signing + token HMAC. Required in prod; main-node mints a
   *  per-process random one when omitted (callers SHOULD warn). */
  secret: string;
  /** Public origin (used for redirect URLs + cookie domain). */
  baseURL?: string;
  /** Email sender; null disables every email-bearing better-auth flow.
   *  CF prod always passes a real sender; self-host without SMTP passes
   *  null. */
  sender: EmailSender | null;
  /** Optional Google OAuth. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Optional GitHub OAuth for console account sign-in. */
  githubClientId?: string;
  githubClientSecret?: string;
  /** When true, sign-up requires email verification before the user is
   *  signed in. Default: false on self-host (no SMTP path), true on CF prod. */
  requireEmailVerify?: boolean;
  /** Cross-subdomain cookie domain (e.g. ".openma.dev"). Skip for default
   *  per-host scoping. */
  cookieDomain?: string;
  /** Idempotent ensure-tenant; called from databaseHooks.user.create.after.
   *  Runtimes pass their own implementation: CF writes to the legacy
   *  `tenant` + `membership` + `tenant_shard` tables; Node writes to the
   *  packages/schema tenant tables only (no shard router). */
  ensureTenant: (user: {
    id: string;
    name?: string | null;
    email?: string | null;
  }) => Promise<unknown>;
  /** Optional drizzle-adapter pre-built by CF; pass `database` instead
   *  on Node. Ignored when not provided. */
  drizzleProvider?: "sqlite" | "pg";
  /** OpenID Connect providers offered next to the built-in ones. */
  oidcProviders?: readonly OidcSignInProvider[];
  /** When false, email and password sign-in, sign-up, and email codes are
   *  all disabled, so only the OAuth and OIDC providers can sign users in.
   *  Default: true. */
  emailPassword?: boolean;
}

export type BetterAuth = ReturnType<typeof betterAuth>;

function otpEmailHtml(code: string, label: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    `<h2 style="margin:0 0 16px">${label}</h2>`,
    `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">${code}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 5 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

export function buildBetterAuth(opts: BuildBetterAuthOpts) {
  const socialProviders = buildSocialProviders(opts);

  const sender = opts.sender;
  const requireVerify = !!opts.requireEmailVerify;
  const emailPassword = opts.emailPassword ?? true;
  const oidcProviders = opts.oidcProviders ?? [];
  validateOidcSignInProviders(oidcProviders);

  const plugins: unknown[] = [];
  if (oidcProviders.length > 0) {
    plugins.push(
      genericOAuth({
        config: oidcProviders.map((p) => ({
          providerId: p.id,
          discoveryUrl: p.discoveryUrl,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          scopes: p.scopes ?? ["openid", "profile", "email"],
          pkce: true,
          authentication: p.clientAuthentication ?? "post",
          // The identity provider owns the profile: refresh name and picture
          // URL on every sign-in, not only when the user is first created.
          overrideUserInfo: true,
        })),
      }),
    );
  }
  if (sender && emailPassword) {
    plugins.push(
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOnSignUp: requireVerify,
        async sendVerificationOTP({ email, otp, type }) {
          const labels: Record<string, string> = {
            "sign-in": "Your sign-in code",
            "email-verification": "Verify your email",
            "forget-password": "Your password reset code",
          };
          const label = labels[type] ?? "Your verification code";
          await sender.send({
            to: email,
            subject: `${label} — openma`,
            html: otpEmailHtml(otp, label),
            text: `${label}: ${otp}`,
          });
        },
      }),
    );
  }

  const emailVerification = sender && emailPassword
    ? {
        sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
          await sender.send({
            to: user.email,
            subject: "Verify your email — openma",
            html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Verify your email</h2><p>Click the button below to verify your email address.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Verify email</a></div>`,
            text: `Verify your email: ${url}`,
          });
        },
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
      }
    : undefined;

  const sendResetPassword = sender && emailPassword
    ? async ({ user, url }: { user: { email: string }; url: string }) => {
        await sender.send({
          to: user.email,
          subject: "Reset your password — openma",
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Reset your password</h2><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Reset password</a></div>`,
          text: `Reset your password: ${url}`,
        });
      }
    : undefined;

  return betterAuth({
    basePath: "/auth",
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: opts.database as never,
    emailAndPassword: {
      enabled: emailPassword,
      requireEmailVerification: requireVerify,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    ...(emailVerification ? { emailVerification } : {}),
    plugins: plugins as never,
    socialProviders,
    trustedOrigins: opts.baseURL ? [opts.baseURL] : ["*"],
    ...(opts.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: opts.cookieDomain,
            },
            defaultCookieAttributes: {
              domain: opts.cookieDomain,
              sameSite: "lax" as const,
              secure: true,
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false },
        role: { type: "string", required: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name?: string | null; email?: string | null }) => {
            try {
              await opts.ensureTenant(user);
            } catch (err) {
              // Don't block sign-up on tenant creation — auth middleware's
              // self-heal path retries on first authenticated request.
              console.error("[auth-config] ensureTenant hook failed:", err);
            }
          },
        },
      },
    },
  });
}
