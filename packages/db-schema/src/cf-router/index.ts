// CF ROUTER_DB schema (SQLite / D1).
//
// Holds: tenant_shard, shard_pool, memory_store_tenant.
//
// Multi-shard control-plane only. Single-D1 self-host deployments don't
// use this binding (env.ROUTER_DB falls back to env.MAIN_DB).
//
// drizzle-kit consumes this barrel via drizzle.cf-router.config.ts and
// emits migrations into apps/main/migrations-router/.

export * from "./sharding";
