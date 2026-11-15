// The Session's EgressPolicy (design §0.1), compiled the same way on every
// control plane: the Environment networking plus the Session's sandbox
// substitutions. Shared by the Cloudflare and Node compositions.

import type { EgressPolicy, Substitution } from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";

/** Networking as stored on the Environment config. */
export interface SessionNetworking {
  type?: string;
  allowed_hosts?: string[];
  allow_package_managers?: boolean;
}

/** Public package sources `allow_package_managers` opens. */
export const PACKAGE_HOSTS: readonly string[] = Object.freeze([
  "pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "*.npmjs.org",
  "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com",
  "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "sum.golang.org", "rubygems.org",
]);

/** Environment networking + substitutions → EgressPolicy. Unrestricted (or
 * unset) without substitutions → null. */
export function sessionEgressPolicy(scope: RuntimeResourceScope, networking: SessionNetworking | undefined, substitutions: Substitution[] = []): EgressPolicy | null {
  if (networking?.type !== "limited" && substitutions.length === 0) return null;
  return {
    scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId, generation: 1 },
    networking: networking?.type === "limited"
      ? {
          type: "limited",
          hosts: [...(networking.allowed_hosts ?? [])],
          packageSources: networking.allow_package_managers ? [...PACKAGE_HOSTS] : [],
          mcpHosts: [],
        }
      : { type: "unrestricted" },
    substitutions,
  };
}

/** The Session's placeholder environment (what the sandbox env gets for
 * environment_variable and cap_cli credentials) as substitutions. The
 * gateway holds the hosts and values and matches them (/resolve,
 * /forward), so a substitution here only marks "this Session needs the
 * forwarder" and carries its placeholder; credentialId is a label. */
export function placeholderSubstitutions(env: Readonly<Record<string, string>>, label: string): Substitution[] {
  return Object.entries(env).map(([envName, placeholder]) => ({
    credentialId: `${label}:${envName}`,
    envName,
    placeholder,
    hosts: [],
    inject: { header: true, body: false },
  }));
}
