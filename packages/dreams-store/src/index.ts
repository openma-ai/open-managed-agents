// Public surface of @open-managed-agents/dreams-store.
//
//   - types       : domain DTOs + model/status enums
//   - errors      : typed errors for the route layer to map → HTTP status
//   - ports       : abstract deps (DreamRepo, Clock, IdGenerator, Logger)
//   - service     : DreamService (pure business logic)
//   - adapters    : Cloudflare D1 + SQLite factories
//
// Spec: https://platform.claude.com/docs/en/managed-agents/dreams

export * from "./types";
export * from "./errors";
export * from "./ports";
export { DreamService } from "./service";
export type { DreamServiceDeps } from "./service";
export { SqlDreamRepo, createCfDreamService, createSqliteDreamService } from "./adapters";
