import type { CredentialVault, CredentialVaultCreateRequest } from "@alibaba-group/opensandbox";
import type { SandboxEgressPort } from "@open-managed-agents/sandbox";
import { compileFirewall, normalizeHostPattern } from "@open-managed-agents/sandbox-port-kit/firewall";
import { SandboxAssemblyError, type SandboxEgressDepsPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit/ports";

/** SDK errors may contain secret-bearing request bodies. */
export async function revokeOpenSandboxVault(vault: Pick<CredentialVault, "delete">): Promise<void> {
  try { await vault.delete(); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404)) {
      throw new Error("OpenSandbox native Vault revocation failed; destroy sandbox before capture or reuse");
    }
  }
}

/** Opt-in provider custody of credentials. No raw secret is passed to exec,
 * files or environment. Full delete/create avoids sidecar merge semantics
 * retaining removed grants. A failed revocation propagates to the host, which
 * must destroy the sandbox rather than snapshot it. */
export function createOpenSandboxNativeEgress<R extends object>(
  vendor: SandboxVendorPort<R>,
  vaultOf: (runtime: R) => Pick<CredentialVault, "create" | "delete">,
  deps: SandboxEgressDepsPort,
): SandboxEgressPort<R> {
  if (!deps.secrets) throw new SandboxAssemblyError("OpenSandbox native Vault requires secrets.read; choose gateway to keep provider custody disabled");
  if (!vendor.applyFirewall) throw new SandboxAssemblyError("OpenSandbox native Vault requires network enforcement");
  const names = new WeakMap<R, Set<string>>();
  const queues = new WeakMap<R, Promise<void>>();
  const serial = (runtime: R, operation: () => Promise<void>) => {
    const next = (queues.get(runtime) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(runtime, next);
    return next;
  };
  const revoke = async (runtime: R) => {
    await revokeOpenSandboxVault(vaultOf(runtime));
    const previous = names.get(runtime);
    if (previous?.size) {
      try { await vendor.setEnv(runtime, Object.fromEntries([...previous].map(name => [name, ""]))); }
      catch { throw new Error("OpenSandbox native Vault placeholder cleanup failed"); }
    }
    names.delete(runtime);
  };
  const configure = async (input: Parameters<SandboxEgressPort<R>["attach"]>[0]) => {
    // Remove any existing revision, including one restored from provider state,
    // before checking new input or performing network/secret operations.
    await revoke(input.runtime);
    input.signal.throwIfAborted();
    const policy = input.policy;
    if (policy && (policy.scope.workspaceId !== input.scope.workspaceId || policy.scope.sessionId !== input.scope.sessionId)) {
      throw new SandboxAssemblyError("OpenSandbox native Vault policy scope mismatch");
    }
    const substitutions = policy?.substitutions ?? [];
    // The SDK does not specify whether overlapping bindings accumulate or use
    // first match. Do not silently promise multiple substitutions on a request.
    if (substitutions.length > 1) throw new SandboxAssemblyError("OpenSandbox native Vault currently supports one substitution per policy; use gateway for multiple substitutions");
    const body: CredentialVaultCreateRequest = { credentials: [], bindings: [] };
    const env: Record<string, string> = {};
    for (const sub of substitutions) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sub.envName) || !sub.placeholder || !sub.hosts.length || (!sub.inject.header && !sub.inject.body)) {
        throw new SandboxAssemblyError("Invalid OpenSandbox native Vault substitution");
      }
      const hosts = sub.hosts.map(normalizeHostPattern);
      let secret: { value: string; expiresAt: number | null };
      try { secret = await deps.secrets!.read(sub.credentialId); }
      catch { throw new Error("OpenSandbox native Vault credential resolution failed"); }
      // SDK Vault bindings have no expiry. A timer in an evictable host would
      // not guarantee revocation, so temporary credentials must use gateway.
      if (secret.expiresAt !== null) throw new SandboxAssemblyError("OpenSandbox native Vault cannot enforce expiring credentials; use gateway");
      if (!secret.value || secret.value === sub.placeholder) throw new SandboxAssemblyError("Invalid OpenSandbox native Vault credential value");
      body.credentials.push({ name: "oma-0", source: { type: "inline", value: secret.value } });
      body.bindings.push({ name: "oma-0", match: { schemes: ["https"], hosts }, auth: { type: "passthrough", substitutions: [{ credential: "oma-0", placeholder: sub.placeholder, in: [...(sub.inject.header ? ["header" as const] : []), ...(sub.inject.body ? ["body" as const] : [])] }] } });
      env[sub.envName] = sub.placeholder;
    }
    try {
      input.signal.throwIfAborted();
      await vendor.applyFirewall!(input.runtime, compileFirewall(policy, {
        gateway: { hosts: [new URL(deps.gateway.endpoint.url).hostname], fixedIps: deps.gateway.endpoint.fixedIps },
        channels: [...(await deps.channels?.(input.scope) ?? [])],
      }));
      if (!body.credentials.length) return;
      await vaultOf(input.runtime).create(body);
      input.signal.throwIfAborted();
      names.set(input.runtime, new Set(Object.keys(env)));
      await vendor.setEnv(input.runtime, env);
    } catch {
      await revoke(input.runtime);
      // SDK error bodies can echo credential values: no cause or raw message.
      throw new Error("OpenSandbox native Vault configuration failed");
    }
  };
  return {
    attach: input => serial(input.runtime, () => configure(input)),
    update: input => serial(input.runtime, () => configure({ ...input, signal: new AbortController().signal })),
    revoke: input => serial(input.runtime, () => revoke(input.runtime)),
  };
}
