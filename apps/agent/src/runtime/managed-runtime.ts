import {
  createCloudflareManagedEnvironmentWorker as createCoreEnvironmentWorker,
  createCloudflareManagedRuntime as createCoreRuntime,
  createCloudflareManagedRuntimeDriver as createCoreDriver,
  createCloudflareManagedRuntimeHost as createCoreHost,
  type CloudflareManagedEnvironmentWorkerOptions as CoreEnvironmentWorkerOptions,
  type CloudflareManagedRuntimeDriverOptions as CoreDriverOptions,
  type CloudflareManagedRuntimeHostOptions as CoreHostOptions,
  type CloudflareManagedRuntimeOptions as CoreRuntimeOptions,
} from "@open-managed-agents/managed-runtime-cloudflare";
import { SqlEnvironmentWorkClaimPort } from "@open-managed-agents/environment-work-store-sql";
import { issueSandboxToken, sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";
import { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } from "@open-managed-agents/sandbox-gateway-sql";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import type { Env } from "@open-managed-agents/shared";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

import { CloudflareSandbox } from "./sandbox";

export interface CloudflareManagedRuntimeOptions
  extends Omit<CoreRuntimeOptions, "createSandbox"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
}

export interface CloudflareManagedRuntimeHostOptions
  extends Omit<CoreHostOptions, "createSandbox" | "claims"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
  claims?: CoreHostOptions["claims"];
}

export interface CloudflareManagedRuntimeDriverOptions
  extends Omit<CoreDriverOptions, "createSandbox"> {
  createSandbox?: CoreRuntimeOptions["createSandbox"];
}

export interface CloudflareManagedEnvironmentWorkerOptions
  extends Omit<CoreEnvironmentWorkerOptions, "runtime"> {
  runtime: CloudflareManagedRuntimeHostOptions;
}

function withSdkSandbox<Options extends CloudflareManagedRuntimeOptions>(
  options: Options,
): Options & Pick<CoreRuntimeOptions, "createSandbox"> {
  return {
    ...options,
    createSandbox: options.createSandbox
      ?? ((runtimeEnv: Env, runtimeId: string) => new CloudflareSandbox(runtimeEnv, runtimeId)),
  };
}

/** The sandbox token of a credential egress binding (design §0.0b B.3):
 * issued under the Environment Work claim the binding runs for, into that
 * Work row in the workspace's tenant D1, so it dies with the claim (reclaim,
 * stop, lease loss). Scope `egress`: only the outbound binding holds it, as
 * its SHA-256 (container props are not an authority, §0.0b B.2). */
function withWorkClaimSandboxTokens<Options extends Pick<CoreRuntimeOptions, "sandboxTokenSha256">>(
  env: Env,
  options: Options,
): Options {
  return {
    ...options,
    sandboxTokenSha256: options.sandboxTokenSha256 ?? (async ({ scope, generation }) => {
      const tenant = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(scope.workspaceId));
      const token = await issueSandboxToken(
        createSqlEnvironmentWorkSandboxTokenStore(tenant),
        environmentWorkSandboxTokenRef({ ...scope, generation }),
        { scope: "egress" },
      );
      return (await sandboxTokenSha256(token))!;
    }),
  };
}

/** The Work claim Port over each workspace's tenant D1 (ADR 0005): the
 * same managed_environment_work rows the Work API claims and heartbeats. */
function withTenantWorkClaims(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
): CloudflareManagedRuntimeHostOptions & Pick<CoreHostOptions, "claims"> {
  const tenantDb = buildCfTenantDbProvider(env);
  return {
    ...options,
    claims: options.claims ?? new SqlEnvironmentWorkClaimPort(
      async (workspaceId) => new CfD1SqlClient(await tenantDb.resolve(workspaceId)),
    ),
  };
}

/** Cloudflare application convenience wrapper. Provider lifecycle and Port
 * composition live in the isolated managed-runtime-cloudflare package; this
 * shell supplies only its SDK-backed Sandbox implementation. */
export function createCloudflareManagedRuntime(
  env: Env,
  options: CloudflareManagedRuntimeOptions = {},
) {
  return createCoreRuntime(env, withSdkSandbox(withWorkClaimSandboxTokens(env, options)));
}

export function createCloudflareManagedRuntimeDriver(
  env: Env,
  options: CloudflareManagedRuntimeDriverOptions = {},
) {
  return createCoreDriver(env, withSdkSandbox(withWorkClaimSandboxTokens(env, options)));
}

export function createCloudflareManagedRuntimeHost(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
) {
  return createCoreHost(env, withSdkSandbox(withWorkClaimSandboxTokens(env, withTenantWorkClaims(env, options))));
}

export function createCloudflareManagedEnvironmentWorker(
  env: Env,
  options: CloudflareManagedEnvironmentWorkerOptions,
) {
  return createCoreEnvironmentWorker(env, {
    ...options,
    runtime: withSdkSandbox(withWorkClaimSandboxTokens(env, withTenantWorkClaims(env, options.runtime))),
  });
}
