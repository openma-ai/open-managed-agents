// compileFirewall (design §0.2) and the HostPattern rules of §8.4b. No
// Node or provider imports: Workers adapters import this subpath directly.

import type { EgressPolicy, HostPattern } from "@open-managed-agents/sandbox";

export interface FirewallRules {
  /** `open` when the policy is null or unrestricted (platform deny still applies). */
  mode: "open" | "allowlist";
  /** allowed_hosts + package sources + MCP hosts + platform channels (+ gateway). */
  allowHosts: HostPattern[];
  /** Gateway fixed IPs and other CIDR-only grants. */
  allowCidrs: string[];
  /** Platform hard-deny: cloud metadata and loopback (§8.4b). */
  denyAlways: string[];
  /** The gateway is in the allow lists: there are substitutions, or the
   * policy is null and the deployment may add vault_ids at runtime. */
  includesGateway: boolean;
}

/** Never reachable, whatever the policy (§8.4b "永远拒"). Loopback is listed
 * for provider rule sets that apply to it; no adapter can block a sandbox's
 * own in-guest loopback, which the local forwarder relies on. */
export const PLATFORM_DENY_ALWAYS: readonly string[] = Object.freeze([
  "169.254.169.254/32",
  "fd00:ec2::254/128",
  "100.100.100.200/32",
  "metadata.google.internal",
  "127.0.0.0/8",
  "::1/128",
]);

export function compileFirewall(
  policy: EgressPolicy | null,
  platform: { gateway: { hosts: string[]; fixedIps?: readonly string[] }; channels: string[] },
): FirewallRules {
  const includesGateway = policy === null || policy.substitutions.length > 0;
  const allowHosts = new Set<string>();
  const allowCidrs = new Set<string>();
  const addHost = (value: string) => {
    if (isIpLiteral(value)) allowCidrs.add(toCidr(value));
    else allowHosts.add(normalizeHostPattern(value));
  };
  if (includesGateway) {
    for (const host of platform.gateway.hosts) addHost(host);
    for (const ip of platform.gateway.fixedIps ?? []) allowCidrs.add(toCidr(ip));
  }
  if (policy === null || policy.networking.type === "unrestricted") {
    return { mode: "open", allowHosts: [...allowHosts], allowCidrs: [...allowCidrs], denyAlways: [...PLATFORM_DENY_ALWAYS], includesGateway };
  }
  const { hosts, packageSources, mcpHosts } = policy.networking;
  for (const host of [...hosts, ...packageSources, ...mcpHosts]) {
    if (isIpLiteral(host)) throw new TypeError(`limited networking does not accept IP literals: ${host}`);
    allowHosts.add(normalizeHostPattern(host));
  }
  for (const channel of platform.channels) addHost(channel);
  return {
    mode: "allowlist",
    allowHosts: [...allowHosts].sort(),
    allowCidrs: [...allowCidrs].sort(),
    denyAlways: [...PLATFORM_DENY_ALWAYS],
    includesGateway,
  };
}

/** Platform channels from Session resources (design §0.6, 2026-11-08):
 * under `limited` networking an attached github_repository is reachable
 * like allow_mcp_servers, by its URL's host only. URLs that do not parse
 * add nothing (the clone fails with its own error). */
export function repositoryChannels(resources: readonly { type: string; url?: unknown; repo_url?: unknown }[]): string[] {
  const hosts = new Set<string>();
  for (const resource of resources) {
    if (resource.type !== "github_repository" && resource.type !== "github_repo") continue;
    const url = typeof resource.url === "string" ? resource.url : typeof resource.repo_url === "string" ? resource.repo_url : null;
    if (url === null) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") hosts.add(parsed.hostname.toLowerCase());
    } catch {
      // not a URL
    }
  }
  return [...hosts].sort();
}

/** Lower-case, punycode, no trailing dot. Exact host or `*.suffix`; no
 * scheme, port, path, brackets or other wildcards. */
export function normalizeHostPattern(pattern: string): HostPattern {
  const raw = pattern.trim();
  const wildcard = raw.startsWith("*.");
  const host = wildcard ? raw.slice(2) : raw;
  if (host.length === 0 || /[\s/:@?#[\]*\\]/u.test(host)) {
    throw new TypeError(`Invalid host pattern: ${JSON.stringify(pattern)}`);
  }
  let ascii: string;
  try {
    ascii = new URL(`https://${host}`).hostname;
  } catch {
    throw new TypeError(`Invalid host pattern: ${JSON.stringify(pattern)}`);
  }
  ascii = ascii.replace(/\.$/u, "").toLowerCase();
  if (ascii.length === 0 || ascii.split(".").some((label) => label.length === 0)) {
    throw new TypeError(`Invalid host pattern: ${JSON.stringify(pattern)}`);
  }
  return wildcard ? `*.${ascii}` : ascii;
}

/** `*.example.com` matches subdomains only, never `example.com` itself. */
export function matchesHostPattern(host: string, pattern: HostPattern): boolean {
  let normalized: string;
  try {
    normalized = normalizeHostPattern(host);
  } catch {
    return false;
  }
  if (normalized.startsWith("*.")) return false;
  const wanted = normalizeHostPattern(pattern);
  if (!wanted.startsWith("*.")) return normalized === wanted;
  const suffix = wanted.slice(1);
  return normalized.endsWith(suffix) && normalized.length > suffix.length;
}

/** Whether compiled rules let `host` through (host-name rules only). */
export function allowsHost(rules: FirewallRules, host: string): boolean {
  const normalized = host.replace(/\.$/u, "").toLowerCase();
  if (rules.denyAlways.includes(normalized)) return false;
  if (rules.mode === "open") return true;
  return rules.allowHosts.some((pattern) => matchesHostPattern(normalized, pattern));
}

function isIpLiteral(value: string): boolean {
  const bare = value.replace(/\/\d+$/u, "").replace(/^\[|\]$/gu, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/u.test(bare) || (bare.includes(":") && /^[0-9a-f:.]+$/iu.test(bare));
}

function toCidr(ip: string): string {
  const bare = ip.replace(/^\[|\]$/gu, "");
  if (bare.includes("/")) return bare;
  return bare.includes(":") ? `${bare}/128` : `${bare}/32`;
}
