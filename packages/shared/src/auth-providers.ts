export interface SocialProviderCredentials {
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
}

export type SocialProviderConfig = Record<
  "google" | "github",
  { clientId: string; clientSecret: string; overrideUserInfoOnSignIn: true }
>;

/**
 * Keep Better Auth configuration and the public /auth-info response on the
 * same credential-pair rule. A provider is never exposed when only half of
 * its OAuth credentials are present.
 *
 * The provider owns the profile, so name and picture URL (Google `picture`,
 * GitHub `avatar_url`) are refreshed on every sign-in instead of only when the
 * user is first created.
 */
export function buildSocialProviders(
  credentials: SocialProviderCredentials,
): Partial<SocialProviderConfig> {
  const providers: Partial<SocialProviderConfig> = {};

  if (credentials.googleClientId && credentials.googleClientSecret) {
    providers.google = {
      clientId: credentials.googleClientId,
      clientSecret: credentials.googleClientSecret,
      overrideUserInfoOnSignIn: true,
    };
  }

  if (credentials.githubClientId && credentials.githubClientSecret) {
    providers.github = {
      clientId: credentials.githubClientId,
      clientSecret: credentials.githubClientSecret,
      overrideUserInfoOnSignIn: true,
    };
  }

  return providers;
}

/** A deployment-configured OpenID Connect provider, as shown on sign-in. */
export interface SignInProviderInfo {
  id: string;
  name: string;
}

/**
 * Sign-in methods for the public /auth-info response. `emailPassword: false`
 * drops "email" and "email-otp", matching a Better Auth instance built with
 * email and password disabled.
 */
export function listAuthProviders(
  options: SocialProviderCredentials & { emailOtp?: boolean; emailPassword?: boolean },
): string[] {
  const emailPassword = options.emailPassword ?? true;
  return [
    ...(emailPassword ? ["email"] : []),
    ...(emailPassword && options.emailOtp ? ["email-otp"] : []),
    ...Object.keys(buildSocialProviders(options)),
  ];
}
