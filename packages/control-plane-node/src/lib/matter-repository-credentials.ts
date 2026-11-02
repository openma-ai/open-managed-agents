import type { RepositoryBondCredentialSource } from "./node-managed-session-inputs.js";
import { MATTER_INTERNAL_PREFIX, MATTER_PROXY_HEADERS } from "./matter-proxy.js";

/** Matter's route for a repository's Bond credential (apps/matter). */
export const MATTER_REPOSITORY_CREDENTIAL_PATH = `${MATTER_INTERNAL_PREFIX}/repository-credential`;

/**
 * Repository Bond credentials from the Matter service, which owns the
 * workspace's Bonds and their sealed tokens. One request per prepared
 * repository; nothing is cached, so revoking a Bond takes effect at once.
 * Matter's error message (never a secret) is passed on; the token never is.
 */
export function matterRepositoryCredentials(options: {
  readonly url: string;
  readonly proxySecret: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}): RepositoryBondCredentialSource {
  const doFetch = options.fetcher ?? fetch;
  return {
    async repositoryToken({ workspaceId, url }) {
      let response: Response;
      try {
        response = await doFetch(`${options.url}${MATTER_REPOSITORY_CREDENTIAL_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MATTER_PROXY_HEADERS.internal]: options.proxySecret,
            [MATTER_PROXY_HEADERS.tenant]: workspaceId,
          },
          body: JSON.stringify({ url }),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch {
        throw new Error(`Matter could not be reached for the Bond credential of ${url}`);
      }
      const body = (await response.json().catch(() => null)) as
        | { token?: unknown; error?: unknown }
        | null;
      if (!response.ok || typeof body?.token !== "string" || body.token === "") {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`No Bond credential for repository ${url}: ${reason}`);
      }
      return body.token;
    },
  };
}
