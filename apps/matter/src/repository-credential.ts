/**
 * `POST /internal/repository-credential`: the token of the workspace's GitLab
 * Bond for a repository URL, for the OpenMA control plane to clone or fetch a
 * Session repository added without a token. Only the control plane may call
 * it: it sends the shared secret in `x-matter-internal-secret`, which its
 * Console proxy never sends and refuses `/matter/internal/*` outright.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { MATTER_PROXY_HEADERS } from "./feishu-connect.js";
import type { GitLabConnectionRecord, MatterDatabase } from "./persistence.js";

export const REPOSITORY_CREDENTIAL_PATH = "/internal/repository-credential";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Why no Bond can clone a URL; the message names no secret. */
export class RepositoryBondError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "RepositoryBondError";
  }
}

/** The repository URL as a GitLab project URL: http(s), no credentials,
 * query or fragment, and a project path under the instance root. */
const parseRepositoryUrl = (value: unknown): URL => {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {}
  if (
    url === undefined ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    // The URL is cloned as given: refuse forms (`..`, escapes) it would only
    // match after normalization.
    url.href !== value
  ) {
    throw new RepositoryBondError("url must be an http(s) repository URL without credentials", 400);
  }
  return url;
};

/**
 * The one GitLab Bond of `tenantId` whose instance serves `url`. A project
 * path must follow the instance root; two Bonds on one instance are
 * ambiguous (each may be a different bot user) and refused.
 */
export const findRepositoryBond = async (
  db: Pick<MatterDatabase, "gitlab">,
  tenantId: string,
  value: unknown,
): Promise<GitLabConnectionRecord> => {
  const url = parseRepositoryUrl(value);
  const target = `${url.origin}${url.pathname}`;
  const matches = (await db.gitlab.list()).filter((bond) => {
    if (bond.tenantId !== tenantId) return false;
    const root = bond.baseUrl.replace(/\/+$/, "");
    const rest = target.startsWith(`${root}/`) ? target.slice(root.length + 1) : "";
    return /^[^/]+\/[^/]/.test(rest) && !rest.split("/").some((part) => part === "." || part === "..");
  });
  if (matches.length === 0) {
    throw new RepositoryBondError(`No GitLab Bond of this workspace serves ${url.host}`, 404);
  }
  if (matches.length > 1) {
    throw new RepositoryBondError(`Several GitLab Bonds of this workspace serve ${url.host}; keep one`, 409);
  }
  return matches[0]!;
};

export const createRepositoryCredentialHandler = (options: {
  readonly db: Pick<MatterDatabase, "gitlab">;
  /** MATTER_PROXY_SECRET; empty disables the route. */
  readonly secret: string;
  /** Whether this service acts in the tenant. */
  readonly accepts: (tenantId: string) => boolean;
}) =>
  async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== REPOSITORY_CREDENTIAL_PATH) return undefined;
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    const given = request.headers.get(MATTER_PROXY_HEADERS.internal) ?? "";
    const tenantId = request.headers.get(MATTER_PROXY_HEADERS.tenant) ?? "";
    if (options.secret.length === 0 || !timingSafeEqual(digest(given), digest(options.secret)) || tenantId === "") {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!options.accepts(tenantId)) return json({ error: "This Matter service does not serve the workspace" }, 404);
    const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
    try {
      const bond = await findRepositoryBond(options.db, tenantId, body?.url);
      return json({ token: bond.token });
    } catch (error) {
      if (error instanceof RepositoryBondError) return json({ error: error.message }, error.status);
      throw error;
    }
  };
