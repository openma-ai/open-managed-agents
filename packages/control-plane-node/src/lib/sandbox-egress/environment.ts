/**
 * What a Session sandbox needs to use the egress proxy, computed once for
 * every provider: the proxy URL carrying the Session's pass, CA trust
 * variables, and the CLI placeholder environment (`GITHUB_TOKEN=__cap_managed__`).
 * Adapters only store the result (`setEnvVars`, `writeFile`).
 */
import { rootCertificates } from "node:tls";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { ManagedSessionScope } from "@open-managed-agents/managed-credential-resolver";
import type { EgressPassAuthority } from "./pass.js";

/** Where the CA files are written inside the sandbox. */
export const SANDBOX_EGRESS_CA_PATH = "/tmp/openma-egress/ca.crt";
/** Public roots plus the egress CA, for tools whose CA variable replaces the trust store. */
export const SANDBOX_EGRESS_CA_BUNDLE_PATH = "/tmp/openma-egress/ca-bundle.crt";

/** Pseudo-user in the proxy URL; the pass is the password. */
const PASS_USER = "openma";

export interface SandboxEgressSettings {
  /** Proxy address as reachable from sandboxes, `http://host:port`. */
  publicUrl: string;
  caCertificatePem: string;
  passes: EgressPassAuthority;
  passTtlMs: number;
}

/**
 * Proxy and CA trust variables. `caFile` holds only the egress CA (for
 * additive variables); `caBundleFile` the public roots plus it (for
 * variables that replace the trust store, so tunneled hosts still verify).
 */
export function sandboxEgressEnvironment(input: {
  publicUrl: string;
  pass: string;
  caFile: string;
  caBundleFile: string;
}): Record<string, string> {
  const url = new URL(input.publicUrl);
  url.username = PASS_USER;
  url.password = input.pass;
  const proxy = url.toString().replace(/\/$/u, "");
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node >= 24 honors *_PROXY for fetch/http only with this set.
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: input.caFile,
    SSL_CERT_FILE: input.caBundleFile,
    REQUESTS_CA_BUNDLE: input.caBundleFile,
    CURL_CA_BUNDLE: input.caBundleFile,
    GIT_SSL_CAINFO: input.caBundleFile,
    AWS_CA_BUNDLE: input.caBundleFile,
    DENO_CERT: input.caFile,
  };
}

export function caBundle(caCertificatePem: string): string {
  return `${[...rootCertificates, caCertificatePem.trim()].join("\n")}\n`;
}

export interface SandboxEgressLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The proxy as Sessions see it: running, or why it cannot run. */
export type SandboxEgress =
  | { type: "enabled"; settings: SandboxEgressSettings }
  | { type: "unavailable"; reason: string };

// Only names installed by this layer are cleared on a later warm refresh.
// Adapters merge string values, so an empty value disables an old setting.
const installedEnvironment = new WeakMap<object, readonly string[]>();

/**
 * Refresh a Session's egress wiring, including on warm reuse. Sessions
 * without Vaults clear any previously installed settings. A Session whose
 * Vaults hold CLI credentials (placeholders)
 * cannot be prepared while the proxy is unavailable: the error names the
 * reason instead of starting CLIs that would dial out unauthenticated.
 */
export async function applySandboxEgress(input: {
  sandbox: Pick<SandboxExecutor, "setEnvVars" | "writeFile">;
  scope: ManagedSessionScope;
  placeholders: (scope: ManagedSessionScope) => Promise<Record<string, string>>;
  egress: SandboxEgress;
  log: SandboxEgressLogger;
}): Promise<{ proxied: boolean; placeholders: string[] }> {
  const { sandbox, scope, egress, log } = input;
  const replaceEnvironment = async (next: Record<string, string>) => {
    const previous = installedEnvironment.get(sandbox) ?? [];
    if (previous.length === 0 && Object.keys(next).length === 0) return;
    if (sandbox.setEnvVars === undefined) {
      throw new Error("This sandbox cannot set environment variables, so Vault egress credentials cannot reach it");
    }
    const cleared = Object.fromEntries(previous.filter((name) => !(name in next)).map((name) => [name, ""]));
    await sandbox.setEnvVars({ ...cleared, ...next });
    installedEnvironment.set(sandbox, Object.keys(next));
  };
  if (scope.vaultIds.length === 0) {
    await replaceEnvironment({});
    return { proxied: false, placeholders: [] };
  }
  const placeholders = await input.placeholders(scope);
  const names = Object.keys(placeholders);
  const fields = { op: "sandbox_egress.prepare", tenant_id: scope.workspaceId, session_id: scope.sessionId, placeholders: names };
  if (egress.type === "unavailable") {
    if (names.length > 0) {
      throw new Error(
        `Vault CLI credentials (${names.join(", ")}) need the sandbox egress proxy, which is unavailable: ${egress.reason}`,
      );
    }
    await replaceEnvironment({});
    return { proxied: false, placeholders: [] };
  }
  if (sandbox.setEnvVars === undefined) {
    throw new Error("This sandbox cannot set environment variables, so Vault egress credentials cannot reach it");
  }
  const { settings } = egress;
  const caFile = await sandbox.writeFile(SANDBOX_EGRESS_CA_PATH, settings.caCertificatePem);
  const caBundleFile = await sandbox.writeFile(SANDBOX_EGRESS_CA_BUNDLE_PATH, caBundle(settings.caCertificatePem));
  const pass = settings.passes.issue({
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    ttlMs: settings.passTtlMs,
  });
  await replaceEnvironment({
    ...placeholders,
    ...sandboxEgressEnvironment({ publicUrl: settings.publicUrl, pass, caFile, caBundleFile }),
  });
  log.info(fields, "Sandbox egress proxy wired");
  return { proxied: true, placeholders: names };
}
