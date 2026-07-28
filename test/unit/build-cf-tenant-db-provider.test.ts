// Unit tests for buildCfTenantDbProvider — single-D1 mode auto-detection
// + multi-shard mode + the explicit killswitch flag combinations.
//
// Goal: a self-host deployment that omits AUTH_DB_01 from wrangler.jsonc
// should silently land in single-D1 mode (no tenant_shard reads), and
// openma.dev's --env production deployment with all 4 shards should
// continue to use the meta-table router.

import { describe, expect, it } from "vitest";
import {
  CfSharedAuthDbProvider,
  MetaTableTenantDbProvider,
} from "@open-managed-agents/tenant-db";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";

const fakeDb = (label: string) => ({ __label: label }) as unknown as D1Database;

describe("buildCfTenantDbProvider", () => {
  it("returns CfSharedAuthDbProvider when only AUTH_DB binding is present (auto-detected single-D1)", () => {
    const env = { AUTH_DB: fakeDb("AUTH_DB") } as unknown as Parameters<
      typeof buildCfTenantDbProvider
    >[0];
    const provider = buildCfTenantDbProvider(env);
    expect(provider).toBeInstanceOf(CfSharedAuthDbProvider);
  });

  it("returns CfSharedAuthDbProvider when SINGLE_D1_MODE=1 even with shards present", () => {
    const env = {
      AUTH_DB: fakeDb("AUTH_DB"),
      AUTH_DB_01: fakeDb("AUTH_DB_01"),
      AUTH_DB_02: fakeDb("AUTH_DB_02"),
      AUTH_DB_03: fakeDb("AUTH_DB_03"),
      ROUTER_DB: fakeDb("ROUTER_DB"),
      SINGLE_D1_MODE: "1",
    } as unknown as Parameters<typeof buildCfTenantDbProvider>[0];
    const provider = buildCfTenantDbProvider(env);
    expect(provider).toBeInstanceOf(CfSharedAuthDbProvider);
  });

  it("returns CfSharedAuthDbProvider when PER_TENANT_DB_ENABLED='false' (legacy killswitch)", () => {
    const env = {
      AUTH_DB: fakeDb("AUTH_DB"),
      AUTH_DB_01: fakeDb("AUTH_DB_01"),
      ROUTER_DB: fakeDb("ROUTER_DB"),
      PER_TENANT_DB_ENABLED: "false",
    } as unknown as Parameters<typeof buildCfTenantDbProvider>[0];
    const provider = buildCfTenantDbProvider(env);
    expect(provider).toBeInstanceOf(CfSharedAuthDbProvider);
  });

  it("returns MetaTableTenantDbProvider when shards are present (multi-shard production)", () => {
    const env = {
      AUTH_DB: fakeDb("AUTH_DB"),
      AUTH_DB_00: fakeDb("AUTH_DB_00"),
      AUTH_DB_01: fakeDb("AUTH_DB_01"),
      AUTH_DB_02: fakeDb("AUTH_DB_02"),
      AUTH_DB_03: fakeDb("AUTH_DB_03"),
      ROUTER_DB: fakeDb("ROUTER_DB"),
    } as unknown as Parameters<typeof buildCfTenantDbProvider>[0];
    const provider = buildCfTenantDbProvider(env);
    expect(provider).toBeInstanceOf(MetaTableTenantDbProvider);
  });

  it("auto-detection ignores AUTH_DB_00 alone (it's an alias of AUTH_DB on legacy single-shard deploys)", () => {
    // AUTH_DB_00 alone (no AUTH_DB_01..03) means "single shard, alias for
    // AUTH_DB" — that's still single-D1 mode. The canary is AUTH_DB_01,
    // which only exists in multi-shard deployments.
    const env = {
      AUTH_DB: fakeDb("AUTH_DB"),
      AUTH_DB_00: fakeDb("AUTH_DB_00"),
      ROUTER_DB: fakeDb("ROUTER_DB"),
    } as unknown as Parameters<typeof buildCfTenantDbProvider>[0];
    const provider = buildCfTenantDbProvider(env);
    expect(provider).toBeInstanceOf(CfSharedAuthDbProvider);
  });
});
