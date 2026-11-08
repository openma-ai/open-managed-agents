// A deployment that leaves PUBLIC_BASE_URL unset gives better-auth no way to
// tell http from https, so it issues the session cookie with the `Secure`
// attribute (named `__Secure-better-auth.session_token`). Browsers then refuse
// to store it on a plain-HTTP origin: sign-in answers 200, the Console's
// session check sees no cookie, and every visit bounces back to /login. The
// only other clue is one vague warning from better-auth, which is easy to miss
// in a self-host log. Emit an actionable one at startup instead.

export interface AuthCookieWarningInput {
  /** Auth is disabled: /auth is not mounted, so no cookie can be lost. */
  authDisabled: boolean;
  /** NodeConfig.http.publicBaseUrl — the value handed to better-auth as baseURL. */
  publicBaseUrl: string | undefined;
}

export const MISSING_PUBLIC_BASE_URL_WARNING =
  "PUBLIC_BASE_URL is unset, so better-auth marks the session cookie Secure. "
  + "Browsers drop such a cookie on a plain-HTTP origin: sign-in returns 200 and "
  + "then redirects back to /login. Set PUBLIC_BASE_URL to the origin users open, "
  + "without a trailing slash — for example PUBLIC_BASE_URL=http://host:8787, or "
  + "an https:// URL when TLS terminates in front of this process.";

/** The startup warning this configuration deserves, or null when it is fine. */
export function authCookieWarning(input: AuthCookieWarningInput): string | null {
  if (input.authDisabled) return null;
  return input.publicBaseUrl?.trim() ? null : MISSING_PUBLIC_BASE_URL_WARNING;
}
