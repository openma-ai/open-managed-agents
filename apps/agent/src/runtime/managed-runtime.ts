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
  return createCoreRuntime(env, withSdkSandbox(options));
}

export function createCloudflareManagedRuntimeDriver(
  env: Env,
  options: CloudflareManagedRuntimeDriverOptions = {},
) {
  return createCoreDriver(env, withSdkSandbox(options));
}

export function createCloudflareManagedRuntimeHost(
  env: Env,
  options: CloudflareManagedRuntimeHostOptions,
) {
  return createCoreHost(env, withSdkSandbox(withTenantWorkClaims(env, options)));
}

export function createCloudflareManagedEnvironmentWorker(
  env: Env,
  options: CloudflareManagedEnvironmentWorkerOptions,
) {
  return createCoreEnvironmentWorker(env, {
    ...options,
    runtime: withSdkSandbox(withTenantWorkClaims(env, options.runtime)),
  });
}
