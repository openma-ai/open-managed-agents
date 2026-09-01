export interface SocialProviderCredentials {
  googleClientId?: string;
  googleClientSecret?: string;
  githubClientId?: string;
  githubClientSecret?: string;
}

export type SocialProviderConfig = Record<
  "google" | "github",
  { clientId: string; clientSecret: string }
>;

/**
 * Keep Better Auth configuration and the public /auth-info response on the
 * same credential-pair rule. A provider is never exposed when only half of
 * its OAuth credentials are present.
 */
export function buildSocialProviders(
  credentials: SocialProviderCredentials,
): Partial<SocialProviderConfig> {
  const providers: Partial<SocialProviderConfig> = {};

  if (credentials.googleClientId && credentials.googleClientSecret) {
    providers.google = {
      clientId: credentials.googleClientId,
      clientSecret: credentials.googleClientSecret,
    };
  }

  if (credentials.githubClientId && credentials.githubClientSecret) {
    providers.github = {
      clientId: credentials.githubClientId,
      clientSecret: credentials.githubClientSecret,
    };
  }

  return providers;
}

export function listAuthProviders(
  options: SocialProviderCredentials & { emailOtp?: boolean },
): string[] {
  return [
    "email",
    ...(options.emailOtp ? ["email-otp"] : []),
    ...Object.keys(buildSocialProviders(options)),
  ];
}
