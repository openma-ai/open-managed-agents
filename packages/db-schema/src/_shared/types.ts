// Cross-dialect type aliases. Application code imports from here so
// it doesn't have to choose between sqlite-typed or pg-typed table refs.
//
// Pattern:
//   1. Each table is defined in BOTH the cf-* (sqliteTable) and node-pg
//      (pgTable) subpackages.
//   2. The two definitions have structurally identical TS shapes —
//      `typeof x.$inferSelect` is the same regardless of dialect.
//   3. Type aliases here pick ONE side (cf for now, since it covers all
//      tables; node-pg is just a re-export with type-coercion shim) and
//      export it so query/repo code reads `User`, `Agent`, `Session`
//      without picking a dialect at the call site.
//
// Populated alongside Phase 2 ports.
export {};
